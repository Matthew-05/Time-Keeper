import sys
import os
from pathlib import Path
import re
import hashlib
import json
from app_version import APP_VERSION

# True when running from source, False inside the PyInstaller bundle.
# Drives the dev-only niceties — most visibly the webview devtools.
DEV_MODE = not getattr(sys, 'frozen', False)

# Escape hatch: force devtools on in a packaged build by setting
# TIMEKEEPER_DEVTOOLS=1 before launching. Useful for debugging a real install.
DEVTOOLS = DEV_MODE or os.environ.get('TIMEKEEPER_DEVTOOLS') == '1'

# A `timekeeper://` URI on the command line means Windows launched us purely to
# handle a click on a reminder toast's button — see notifications.py. Forward it
# to the instance the user is actually looking at and exit. This has to happen
# before anything heavy is imported: the whole process should be gone in well
# under a second, and it must never reach the point of opening a second window.
_toast_uri = next(
    (arg for arg in sys.argv[1:] if arg.lower().startswith('timekeeper:')), None
)
if _toast_uri:
    import ipc

    if ipc.forward_uri(_toast_uri):
        sys.exit(0)

    # The copy that raised the toast is gone. "Open Time Keeper" is the one
    # action that still means something from a toast left in the Action Center;
    # the other two are about a reminder that no longer exists. Fall through and
    # start normally — the single-instance check below defers to a copy that
    # appeared in the meantime, or opens the window this click was asking for.
    import notifications

    if notifications.parse_action(_toast_uri) != 'open':
        sys.exit(1)

# A second launch defers to the one already open: raise its window and get out
# of the way. This lives up here with the toast handling, before telemetry,
# the database and the updater check, so a deferred launch has no side effects
# of its own. The mutex is what closes the double-click race where both copies
# see no published port and both start; the focus request is what makes the
# second launch feel like it did something.
if __name__ == '__main__':
    import ipc

    if not ipc.claim_single_instance():
        ipc.focus_running_instance()
        sys.exit(0)

from env_config import load_env_file
from usage_logger import UsageLogger

try:
    load_env_file()
except (OSError, ValueError) as exc:
    # Telemetry is optional and must never prevent the desktop app from opening.
    print(f"Could not load the optional Time Keeper environment file: {exc}")

# Set up temp directories FIRST if running as frozen executable
if not DEV_MODE:
    user_data_dir = os.path.join(Path.home(), 'AppData', 'Local', 'TimeKeeper')
    os.makedirs(user_data_dir, exist_ok=True)
    
    # Create temp directory for webview
    temp_dir = os.path.join(user_data_dir, 'temp')
    os.makedirs(temp_dir, exist_ok=True)
    os.environ['TEMP'] = temp_dir
    os.environ['TMP'] = temp_dir
    
    # Set WebView2 user data folder
    webview_dir = os.path.join(user_data_dir, 'webview2')
    os.makedirs(webview_dir, exist_ok=True)
    os.environ['WEBVIEW2_USER_DATA_FOLDER'] = webview_dir

from flask import Flask, render_template, request, jsonify, redirect, url_for
from models import (
    db, Client, Task_Item, TimeTracking, BreakTracking, Work, Budget, BudgetHold,
    ManualAdjustment, TeamBudget, TeamBudgetMember, TeamBudgetMemberAlias,
    TeamBudgetEntry,
)
import settings as user_settings
# Aliased: `budgets` is also the name of the page's view function and of half
# the local variables in this file, and shadowing the module was a real bug
# waiting to happen.
import budgets as budget_allocation
import team_budgets as team_budget_reporting
import summary as summary_report
import day_close
import day_bounds
from rounding import round_seconds_to_hours
from manual_adjustments import adjustment_figures
import notifications
import ipc
import updater as app_updater
from reminders import ReminderService
from client_colors import normalize_client_color, random_client_color
import atexit
import threading
import time
import math
# `time` is already taken by the stdlib module imported above for time.sleep,
# hence the alias rather than a bare `time` — the clash is why parse_clock_time
# builds its result through datetime(...).time().
from datetime import datetime, date, timedelta, time as clock_time
from sqlalchemy import text, inspect, desc, and_, or_
from flask_migrate import Migrate
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView
from flask_admin.theme import Bootstrap4Theme
import webview
from webview.window import FixPoint
from werkzeug.serving import run_simple
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from sqlalchemy import func, String, literal, case
import socket


_CANONICAL_CLOCK_RE = re.compile(r'^(\d{2}):(\d{2})(?::(\d{2}))?$')
_LEGACY_CLOCK_RE = re.compile(r'^(\d{1,2}):(\d{2})\s+(AM|PM)$', re.IGNORECASE)


def parse_clock_time(value):
    """Parse an API clock value without attaching a date or timezone.

    New clients send canonical ``HH:MM`` (or ``HH:MM:SS`` when preserving
    storage precision). Legacy releases sent ``h:mm AM/PM``. Accepting both at
    this boundary lets UI display formatting change independently from API and
    database contracts. Invalid values raise ``ValueError``.
    """
    if not isinstance(value, str):
        raise ValueError('Clock time must be a string')

    value = value.strip()
    match = _CANONICAL_CLOCK_RE.fullmatch(value)
    if match:
        hours, minutes = int(match.group(1)), int(match.group(2))
        seconds = int(match.group(3) or 0)
    else:
        match = _LEGACY_CLOCK_RE.fullmatch(value)
        if not match:
            raise ValueError('Expected HH:MM, HH:MM:SS, or h:mm AM/PM')
        hour_12, minutes = int(match.group(1)), int(match.group(2))
        if not 1 <= hour_12 <= 12:
            raise ValueError('12-hour clock hour is out of range')
        hours = hour_12 % 12
        if match.group(3).upper() == 'PM':
            hours += 12
        seconds = 0

    if not 0 <= hours <= 23 or not 0 <= minutes <= 59 or not 0 <= seconds <= 59:
        raise ValueError('Clock time is out of range')
    return datetime(2000, 1, 1, hours, minutes, seconds).time()


user_data_dir = os.path.join(Path.home(), 'AppData', 'Local', 'TimeKeeper')
os.makedirs(user_data_dir, exist_ok=True)

# Database file path
db_path = os.path.join(user_data_dir, 'clients.db')

# Initialize Flask with correct configuration
if not DEV_MODE:
    # We are running in a bundle - use _MEIPASS for onefile mode
    bundle_dir = getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    template_folder = os.path.join(bundle_dir, 'templates')
    static_folder = os.path.join(bundle_dir, 'static')
    print(f"Running as frozen executable")
    print(f"Bundle dir: {bundle_dir}")
    print(f"Template folder: {template_folder}")
    print(f"Static folder: {static_folder}")
    print(f"Template folder exists: {os.path.exists(template_folder)}")
    print(f"Static folder exists: {os.path.exists(static_folder)}")
    
    # Log application startup in frozen state
    UsageLogger.send_log('Program started', {
        'version': APP_VERSION,
        'frozen_state': True,
        'bundle_dir': bundle_dir
    })
    
    app = Flask(__name__, 
                template_folder=template_folder,
                static_folder=static_folder)
else:
    # We are running in a normal Python environment
    print(f"Running in development mode")
    
    # Log application startup in development mode (for debugging)
    UsageLogger.send_log('Program started', {
        'version': APP_VERSION,
        'frozen_state': False,
        'working_directory': os.getcwd()
    })
    
    app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key_here'
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['MAX_CONTENT_LENGTH'] = 12 * 1024 * 1024
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

if DEV_MODE:
    # Don't let the webview sit on a stale app.css / base.js between edits.
    app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
    app.config['TEMPLATES_AUTO_RELOAD'] = True

# Tell SQLAlchemy to use the user directory for instance data
app.instance_path = user_data_dir

# Update work is performed on background threads so neither app startup nor the
# Settings page blocks on GitHub. Only this small state snapshot is shared with
# Flask request threads; the network and filesystem operations live in updater.py.
_update_lock = threading.Lock()
_update_info = None
_verified_installer = None
_update_status = {
    'state': 'idle',
    'current_version': APP_VERSION,
    'latest_version': None,
    'release_url': None,
    'progress': None,
    'error': None,
    'frozen': not DEV_MODE,
}
_update_dir = os.path.join(user_data_dir, 'updates')


def _set_update_status(**changes):
    with _update_lock:
        _update_status.update(changes)


def _get_update_status():
    with _update_lock:
        return dict(_update_status)


def _check_for_update_worker(startup=False):
    global _update_info, _verified_installer
    print(f'[updater] Starting {"startup" if startup else "manual"} update check.')
    try:
        result = app_updater.check_for_update(APP_VERSION)
        with _update_lock:
            _update_info = result
            _verified_installer = None
        if result is None:
            print(f'[updater] Update check complete: application is current at v{APP_VERSION}.')
            _set_update_status(
                state='up_to_date', latest_version=APP_VERSION,
                release_url=None, progress=None, error=None,
            )
        else:
            print(f'[updater] Update check complete: v{result.latest_version} is available.')
            _set_update_status(
                state='available', latest_version=result.latest_version,
                release_url=result.release_url, progress=None, error=None,
            )
    except app_updater.UpdateError as exc:
        print(f'[updater] Update check failed: {exc}')
        _set_update_status(state='error', progress=None, error=str(exc))
    except Exception as exc:
        print(f'[updater] Unexpected update check failure: {exc}')
        logger.exception('Unexpected update check failure')
        _set_update_status(state='error', progress=None, error='Could not check for updates.')
def _start_update_check(startup=False):
    with _update_lock:
        if _update_status['state'] in {'checking', 'downloading', 'installing'}:
            print(
                f"[updater] Ignored {'startup' if startup else 'manual'} update check; "
                f"current state is {_update_status['state']}."
            )
            return False
        _update_status.update(
            state='checking', latest_version=None, release_url=None,
            progress=None, error=None,
        )
    print(f'[updater] Queued {"startup" if startup else "manual"} update check.')
    threading.Thread(
        target=_check_for_update_worker,
        kwargs={'startup': startup},
        name='timekeeper-update-check',
        daemon=True,
    ).start()
    return True


def _download_update_worker():
    global _verified_installer
    with _update_lock:
        info = _update_info

    def report(received, total):
        percentage = min(100, int(received * 100 / total)) if total else None
        _set_update_status(progress=percentage)

    try:
        verified = app_updater.download_update(info, _update_dir, progress=report)
        with _update_lock:
            _verified_installer = verified
        _set_update_status(state='ready', progress=100, error=None)
    except app_updater.UpdateError as exc:
        _set_update_status(state='error', progress=None, error=str(exc))
    except Exception:
        logger.exception('Unexpected update download failure')
        _set_update_status(state='error', progress=None, error='Could not download the update.')


def start_startup_update_check():
    """Check for updates in the background on every packaged-app launch."""
    if DEV_MODE:
        print('[updater] Skipped startup update check in development mode.')
        return False
    print('[updater] Checking for updates on packaged-app startup.')
    return _start_update_check(startup=True)

# Now initialize the database with the configured app
db.init_app(app)
migrate = Migrate(app, db)

timer_running = False
timer_value = 0

def timer_thread():
    global timer_running, timer_value
    while True:
        if timer_running:
            timer_value += 1
            print(f"Timer value: {timer_value}")
        time.sleep(1)

@app.route('/start_timer')
def start_timer():
    print("Started timer")
    global timer_running
    timer_running = True
    timer_thread()
    return jsonify({'message': 'Timer started'})

@app.route('/stop_timer')
def stop_timer():
    print("Stopped timer")
    global timer_running
    timer_running = False
    return jsonify({'message': 'Timer stopped'})

@app.route('/timer_status')
def timer_status():
    global timer_running, timer_value
    return jsonify({'running': timer_running, 'value': timer_value})

@app.url_defaults
def add_static_cache_key(endpoint, values):
    """Stamp every static URL with the file's mtime.

    Without this the browser is free to keep serving whatever copy of
    `task_browser.js` it already has, and a webview will. That produces the
    worst kind of bug report: a stack trace whose line numbers don't match the
    file on disk, and errors like `this.someNewMethod is not a function` for a
    method that is plainly right there — because the cached module predates it.

    `SEND_FILE_MAX_AGE_DEFAULT = 0` above only covers DEV_MODE, and even then
    it asks politely. A changed URL isn't a request not to cache; it's a
    different file as far as the cache is concerned, so there is nothing to
    revalidate and nothing to get wrong. The mtime means the URL only changes
    when the asset does, so unchanged files still cache normally.
    """
    if endpoint != 'static' or 'filename' not in values:
        return

    if not app.static_folder:
        return

    path = os.path.join(app.static_folder, values['filename'])
    try:
        values['v'] = int(os.stat(path).st_mtime)
    except OSError:
        # A missing or unreadable file is the 404's problem, not ours.
        pass


@app.context_processor
def inject_version():
    # `dev_mode` gates the developer-only bits of the settings page. It's a
    # template flag rather than a settings key on purpose — it describes how the
    # app was launched, not a preference anyone gets to change.
    return dict(app_version=APP_VERSION, dev_mode=DEV_MODE)


@app.context_processor
def inject_settings():
    """Make user settings available to every template.

    `base.html` needs the theme before it renders the opening <html> tag, so the
    value has to be here rather than passed by individual view functions.
    Reading a small JSON file per render is fine at this scale and keeps a stale
    cached copy from ever being a possibility.
    """
    return dict(settings=user_settings.load_settings())


@app.route('/settings')
def settings_page():
    return render_template('settings.html', version=APP_VERSION)


@app.route('/work-calendar')
def work_calendar_page():
    """Calendar editor for recurring capacity and date-specific exceptions."""
    return render_template('work_calendar.html', version=APP_VERSION)


@app.route('/api/settings', methods=['GET'])
def api_get_settings():
    return jsonify(user_settings.load_settings())


@app.route('/api/settings', methods=['PUT'])
def api_update_settings():
    """Merge the posted keys into stored settings.

    `update_settings` ignores unknown keys and replaces invalid values with the
    default, so the worst a bad payload does is not change anything. The saved
    settings come back so the client can re-render from what was actually
    stored rather than from what it hoped it stored.
    """
    changes = request.get_json(silent=True)
    if not isinstance(changes, dict):
        return jsonify({'error': 'Expected a JSON object'}), 400

    unknown = [key for key in changes if key not in user_settings.DEFAULTS]
    if unknown:
        return jsonify({'error': f'Unknown setting(s): {", ".join(sorted(unknown))}'}), 400
    if 'work_schedule_history' in changes:
        return jsonify({'error': 'Work schedule history is managed automatically.'}), 400

    try:
        saved = user_settings.update_settings(changes)
    except OSError as exc:
        logger.error(f'Could not save settings: {exc}')
        return jsonify({'error': 'Could not write the settings file'}), 500

    return jsonify(saved)


@app.route('/api/update/status', methods=['GET'])
def api_update_status():
    """Return the current background update job state."""
    return jsonify(_get_update_status())


@app.route('/api/update/check', methods=['POST'])
def api_update_check():
    started = _start_update_check(startup=False)
    return jsonify({**_get_update_status(), 'started': started}), (202 if started else 200)


@app.route('/api/update/download', methods=['POST'])
def api_update_download():
    with _update_lock:
        if _update_status['state'] != 'available' or _update_info is None:
            return jsonify({'error': 'No verified update release is ready to download.'}), 409
        _update_status.update(state='downloading', progress=0, error=None)
    threading.Thread(
        target=_download_update_worker,
        name='timekeeper-update-download',
        daemon=True,
    ).start()
    return jsonify(_get_update_status()), 202


@app.route('/api/update/install', methods=['POST'])
def api_update_install():
    if DEV_MODE:
        return jsonify({'error': 'Updates can only be installed from a packaged build.'}), 409

    with _update_lock:
        if _update_status['state'] != 'ready' or _verified_installer is None:
            return jsonify({'error': 'No verified installer is ready to open.'}), 409
        installer = _verified_installer
        _update_status.update(state='installing', error=None)

    try:
        app_updater.launch_installer(installer)
    except (app_updater.UpdateError, OSError) as exc:
        _set_update_status(state='ready', error=f'Could not open the installer: {exc}')
        return jsonify({'error': f'Could not open the installer: {exc}'}), 500

    # Let this response reach the local UI, then use the same pywebview API seam
    # as the title-bar Close button. Inno can now replace the executable without
    # self-overwrite tricks or an abrupt os._exit.
    threading.Timer(0.35, lambda: WebviewAPI().close()).start()
    return jsonify(_get_update_status()), 202


@app.route('/api/work-calendar', methods=['GET', 'POST'])
def api_work_calendar():
    """Resolved capacity for a requested calendar window.

    Returning evaluated days keeps the calendar display and budget projections
    on exactly the same rules, including overlapping ranges where later rules
    win one field at a time. POST evaluates an unsaved editor draft without
    mutating the settings file.
    """
    try:
        start = date.fromisoformat(request.args.get('start', ''))
        end = date.fromisoformat(request.args.get('end', ''))
    except (TypeError, ValueError):
        return jsonify({'error': 'Expected ISO start and end dates.'}), 400

    if end < start:
        return jsonify({'error': 'The calendar end date must follow its start date.'}), 400
    if (end - start).days > 370:
        return jsonify({'error': 'Calendar windows are limited to one year.'}), 400

    if request.method == 'POST':
        changes = request.get_json(silent=True)
        if not isinstance(changes, dict):
            return jsonify({'error': 'Expected a JSON object'}), 400
        allowed = {
            'work_hours_per_day',
            'work_days',
            'work_calendar_overrides',
        }
        unknown = [key for key in changes if key not in allowed]
        if unknown:
            return jsonify({
                'error': f'Unknown calendar setting(s): {", ".join(sorted(unknown))}'
            }), 400
        settings = user_settings.preview_settings(changes)
    else:
        settings = user_settings.load_settings()
    hours = settings['work_hours_per_day']
    work_days = settings['work_days']
    overrides = settings['work_calendar_overrides']
    schedule_history = settings['work_schedule_history']

    days = []
    day = start
    while day <= end:
        details = budget_allocation.workday_details(
            day, hours, work_days, overrides, schedule_history
        )
        days.append({
            'date': day.isoformat(),
            'is_workday': details['is_workday'],
            # Keep calculation precision in the payload; the calendar rounds
            # only for display, while its calendar total still reconciles to
            # the exact value budget projections use.
            'hours': details['hours'],
            'default_hours': details['default_hours'],
            'default_is_workday': details['default_is_workday'],
            'configured_hours': details['configured_hours'],
            'status_overridden': details['status_overridden'],
            'hours_overridden': details['hours_overridden'],
            'active_rule_ids': details['active_rule_ids'],
        })
        day += timedelta(days=1)

    return jsonify({
        'work_hours_per_day': hours,
        'work_days': work_days,
        'schedule_history': schedule_history,
        'overrides': overrides,
        'days': days,
    })


# --------------------------------------------------------------------------
# Description reminder
#
# See reminders.py for the timer itself. This is the glue: what counts as
# "there's something to remind about", what a toast button does when it comes
# back, and where the countdown gets reset.
# --------------------------------------------------------------------------


def reminder_probe():
    """The id of the active task worth nagging about, or None.

    Both conditions are about not interrupting someone who isn't tracking
    anything: no open task means there's nothing to describe, and no day means
    they haven't started working. The day's *end* time is checked too, for the
    case where a day was closed with a task somehow left open — the working day
    is over either way, so the reminder shouldn't outlive it.

    Returns an id rather than a bool because "until next task" needs to notice
    when the active task *changes*, not merely that one exists.

    Runs on the timer thread, hence the explicit app context.
    """
    with app.app_context():
        today = date.today()

        day = TimeTracking.query.filter_by(date=today).first()
        if day is None or day.end_time is not None:
            return None

        active = Task_Item.query.filter_by(date=today, end_time=None).first()
        return active.id if active else None


reminder_service = ReminderService(
    probe=reminder_probe,
    notifier=notifications,
    settings_module=user_settings,
)


@app.route('/api/reminder/action', methods=['POST'])
def api_reminder_action():
    """Handle a toast button press, forwarded here by ipc.forward_uri.

    The request comes from a second, short-lived copy of this program rather
    than from the page, so there's no session and nothing to authenticate — the
    server only listens on 127.0.0.1. Unknown actions are rejected rather than
    ignored so a typo in a URI shows up as a 400 instead of silence.
    """
    data = request.get_json(silent=True) or {}
    action = notifications.parse_action(data.get('uri'))

    if action == 'snooze':
        minutes = reminder_service.snooze()
        return jsonify({'action': 'snooze', 'minutes': minutes})

    if action == 'snooze-task':
        # None means nothing was running by the time the click arrived — the
        # task was finished from the window first. Nothing to suppress.
        task_id = reminder_service.hold_until_next_task()
        return jsonify({'action': 'snooze-task', 'held_task_id': task_id})

    if action == 'open':
        return jsonify({'action': 'open', 'focused': focus_window()})

    return jsonify({'error': f'Unknown reminder action: {data.get("uri")!r}'}), 400


def reminder_status_payload():
    """Timer internals plus a live eligibility check, for the dev-mode panel.

    The service's own `eligible` is whatever the last tick found, which is up to
    a tick stale — and immediately after a manual trigger it may not have been
    computed at all. The panel is answering "would a reminder fire right now?",
    so that question gets asked directly rather than read from cache.
    """
    status = reminder_service.status()
    status['active_task_id'] = reminder_probe()
    status['eligible_now'] = status['active_task_id'] is not None
    return status


@app.route('/api/reminder/status', methods=['GET'])
def api_reminder_status():
    """Timer internals, for the dev-mode panel on the settings page."""
    if not DEV_MODE:
        return jsonify({'error': 'Not found'}), 404

    return jsonify(reminder_status_payload())


@app.route('/api/reminder/test', methods=['POST'])
def api_reminder_test():
    """Fire a reminder right now, ignoring the clock and the quiet rules.

    Dev-only. Waiting out a 30-minute interval to check a copy change or a
    button label is not a reasonable way to work, and the alternative — setting
    the interval to 1 and remembering to set it back — is worse.
    """
    if not DEV_MODE:
        return jsonify({'error': 'Not found'}), 404

    sent, error = reminder_service.trigger_now(reason='dev test button')
    # Same payload as /status, so the panel renders identically either way. It
    # previously got the bare service status, which has no `eligible_now` — so
    # the panel read undefined and reported "no" until the next page load.
    return jsonify({'sent': sent, 'error': error, 'status': reminder_status_payload()})


REMOVED_CLIENT_LABEL = 'REMOVED'


def task_client_display_name(task):
    """Label for API/UI when the task's client row was deleted."""
    if task.client_id is None:
        return REMOVED_CLIENT_LABEL
    if task.client is None:
        return REMOVED_CLIENT_LABEL
    return task.client.name


def task_client_color(task):
    """Stored colour for API/UI, or ``None`` when the client was removed."""
    return task.client.color if task.client_id is not None and task.client else None


def _ensure_task_client_id_nullable():
    """SQLite cannot drop NOT NULL in-place; rebuild task__item if needed."""
    eng = db.engine
    if eng.dialect.name != 'sqlite':
        return
    table = Task_Item.__table__.name
    insp = inspect(eng)
    if table not in insp.get_table_names():
        return
    col = next((c for c in insp.get_columns(table) if c['name'] == 'client_id'), None)
    if not col or col.get('nullable'):
        return
    client_table = Client.__table__.name
    tmp = f'{table}_tk_nullable_client'
    with eng.begin() as conn:
        conn.execute(
            text(
                f"""
                CREATE TABLE {tmp} (
                    id INTEGER NOT NULL PRIMARY KEY,
                    date DATE NOT NULL,
                    start_time TIME NOT NULL,
                    end_time TIME,
                    client_id INTEGER,
                    type VARCHAR(50),
                    description TEXT,
                    time_spent INTEGER,
                    adjust_entry BOOLEAN,
                    FOREIGN KEY(client_id) REFERENCES {client_table} (id)
                )
                """
            )
        )
        cols = (
            'id, date, start_time, end_time, client_id, '
            'type, description, time_spent, adjust_entry'
        )
        conn.execute(
            text(f'INSERT INTO {tmp} ({cols}) SELECT {cols} FROM {table}')
        )
        conn.execute(text(f'DROP TABLE {table}'))
        conn.execute(text(f'ALTER TABLE {tmp} RENAME TO {table}'))


def _ensure_task_budget_id_column():
    """Add `task__item.budget_id` to a database created before budgets existed.

    `db.create_all()` creates missing *tables* but never alters an existing one,
    so the `budget` table appears on its own while this column would not. Same
    situation `_ensure_task_client_id_nullable` handles, but far simpler: SQLite
    can add a nullable column with a REFERENCES clause in place, no rebuild.

    Additive and idempotent — the column defaults to NULL on every existing row,
    which means "unpinned", which is exactly what allocation assumed before this
    feature existed.
    """
    eng = db.engine
    if eng.dialect.name != 'sqlite':
        return
    table = Task_Item.__table__.name
    insp = inspect(eng)
    if table not in insp.get_table_names():
        return
    if any(c['name'] == 'budget_id' for c in insp.get_columns(table)):
        return

    budget_table = Budget.__table__.name
    with eng.begin() as conn:
        conn.execute(
            text(
                f'ALTER TABLE {table} ADD COLUMN budget_id INTEGER '
                f'REFERENCES {budget_table} (id) ON DELETE SET NULL'
            )
        )
        conn.execute(
            text(f'CREATE INDEX IF NOT EXISTS ix_{table}_budget_id ON {table} (budget_id)')
        )
    print('Added task__item.budget_id')


def _ensure_task_budget_excluded_column():
    """Add the explicit no-budget marker to databases upgraded in place."""
    table = Task_Item.__table__.name
    insp = inspect(db.engine)
    if any(c['name'] == 'budget_excluded' for c in insp.get_columns(table)):
        return
    with db.engine.begin() as connection:
        connection.execute(text(
            f'ALTER TABLE {table} ADD COLUMN budget_excluded BOOLEAN '
            'NOT NULL DEFAULT 0'
        ))
    print('Added task__item.budget_excluded')


def _ensure_budget_closed_at_column():
    """Add the nullable manual-close marker to pre-existing SQLite databases."""
    eng = db.engine
    if eng.dialect.name != 'sqlite':
        return
    table = Budget.__table__.name
    insp = inspect(eng)
    if table not in insp.get_table_names():
        return
    if any(c['name'] == 'closed_at' for c in insp.get_columns(table)):
        return

    with eng.begin() as conn:
        conn.execute(text(f'ALTER TABLE {table} ADD COLUMN closed_at DATETIME'))
    print('Added budget.closed_at')


def _ensure_team_budget_closed_at_column():
    """Add manual close/reopen support to existing team-budget databases."""
    eng = db.engine
    if eng.dialect.name != 'sqlite':
        return
    table = TeamBudget.__table__.name
    insp = inspect(eng)
    if table not in insp.get_table_names():
        return
    if any(c['name'] == 'closed_at' for c in insp.get_columns(table)):
        return

    with eng.begin() as conn:
        conn.execute(text(f'ALTER TABLE {table} ADD COLUMN closed_at DATETIME'))
    print('Added team_budget.closed_at')


def _ensure_budget_risk_threshold_column():
    """Backfill the per-budget at-risk threshold on existing SQLite databases."""
    eng = db.engine
    if eng.dialect.name != 'sqlite':
        return
    table = Budget.__table__.name
    insp = inspect(eng)
    if table not in insp.get_table_names():
        return
    if any(c['name'] == 'risk_threshold_percent' for c in insp.get_columns(table)):
        return

    with eng.begin() as conn:
        conn.execute(
            text(
                f'ALTER TABLE {table} ADD COLUMN '
                'risk_threshold_percent FLOAT NOT NULL DEFAULT 10'
            )
        )
    print('Added budget.risk_threshold_percent')


def _ensure_client_color_column():
    """Add and randomly backfill ``client.color`` for in-place app upgrades."""
    eng = db.engine
    table = Client.__table__.name
    insp = inspect(eng)
    if table not in insp.get_table_names():
        return

    columns = {column['name'] for column in insp.get_columns(table)}
    added = 'color' not in columns
    with eng.begin() as conn:
        if added:
            # SQLite can add a NOT NULL column in place only with a default.
            # The per-row updates below immediately replace this safety value
            # for existing clients with independently generated colours.
            fallback = random_client_color()
            conn.execute(text(
                f"ALTER TABLE {table} ADD COLUMN color VARCHAR(7) "
                f"NOT NULL DEFAULT '{fallback}'"
            ))

        missing = conn.execute(text(
            f"SELECT id FROM {table} WHERE color IS NULL OR color = ''"
            if not added else f"SELECT id FROM {table}"
        )).fetchall()
        for row in missing:
            conn.execute(
                text(f'UPDATE {table} SET color = :color WHERE id = :id'),
                {'color': random_client_color(), 'id': row[0]},
            )

    if added:
        print(f'Added client.color and assigned {len(missing)} client colour(s)')


def _backfill_works_from_descriptions():
    """Seed `work` from the superseded `task__item.description` column.

    Only ever called when the `work` table did not exist a moment ago, so it
    runs exactly once per database. That matters: re-running it every launch
    would resurrect works the user had deliberately deleted.

    Kept in step with the identical backfill in the Alembic revision
    e5a9c7d1f2b3 — whichever path creates the table does the backfill, and the
    other then finds the table already present and does nothing.
    """
    rows = db.session.execute(
        text(
            """
            SELECT date, client_id, description, start_time
            FROM task__item
            WHERE client_id IS NOT NULL
              AND description IS NOT NULL
              AND TRIM(description) != ''
            ORDER BY date, client_id, start_time
            """
        )
    ).fetchall()

    seen = set()
    payload = []
    for row in rows:
        work_text = (row[2] or '').strip()
        if not work_text:
            continue
        key = (str(row[0]), row[1], work_text.casefold())
        if key in seen:
            continue
        seen.add(key)
        payload.append(
            {
                'date': row[0],
                'client_id': row[1],
                'text': work_text,
                'created_at': f'{row[0]} 00:00:00.000000',
            }
        )

    if not payload:
        return

    db.session.execute(
        text(
            'INSERT INTO work (date, client_id, text, created_at) '
            'VALUES (:date, :client_id, :text, :created_at)'
        ),
        payload,
    )
    db.session.commit()
    print(f'Backfilled {len(payload)} work(s) from task descriptions')


with app.app_context():
    # Has to be sampled *before* create_all, which is what creates the table.
    _work_table_is_new = not inspect(db.engine).has_table(Work.__table__.name)
    db.create_all()
    _ensure_task_client_id_nullable()
    # After the rebuild above, which recreates task__item from a fixed column
    # list and would otherwise drop the column straight back off again.
    _ensure_task_budget_id_column()
    _ensure_task_budget_excluded_column()
    _ensure_budget_closed_at_column()
    _ensure_team_budget_closed_at_column()
    _ensure_budget_risk_threshold_column()
    _ensure_client_color_column()
    if _work_table_is_new:
        _backfill_works_from_descriptions()


#: Sorts above every real timestamp, so an in-progress task ranks as "right now".
_IN_PROGRESS_SORT_KEY = "9999-12-31 23:59:59.999999"


def _task_end_sort_string():
    """Lexicographically sortable 'YYYY-MM-DD HH:MM:SS.ffffff' activity moment per task.

    SQLAlchemy stores SQLite Date/Time as zero-padded ISO text, so plain string
    comparison is chronological.

    A task with no end time gets the sentinel, which sorts above every real
    timestamp — but **only if it is today's**. `end_day` doesn't close tasks
    that were left open, so forgetting to complete one and ending the day
    leaves an open row behind until the next launch sweeps it (`day_close.py`).
    Treating that as "in progress" gave its client the sentinel forever and
    pinned it to the top of the client dropdown above genuinely recent work,
    months later. An abandoned open task is evidence of activity on the day it
    started and nothing more, so it falls back to its own start time — and the
    date check keeps that true inside the window before the sweep runs.
    """
    ended = Task_Item.date.cast(String) + literal(" ") + Task_Item.end_time.cast(String)
    started = Task_Item.date.cast(String) + literal(" ") + Task_Item.start_time.cast(String)

    return case(
        (Task_Item.end_time.isnot(None), ended),
        (Task_Item.date == date.today(), literal(_IN_PROGRESS_SORT_KEY)),
        else_=started,
    )


def clients_query_most_recent_first():
    """Clients ordered by most recent task end time (newest first), then name.

    Clients with no task history at all sort last, alphabetically.
    """
    last_used_sq = (
        db.session.query(
            Task_Item.client_id,
            func.max(_task_end_sort_string()).label("last_used"),
        )
        .filter(Task_Item.client_id.isnot(None))
        .group_by(Task_Item.client_id)
        .subquery()
    )
    return (
        Client.query.outerjoin(last_used_sq, Client.id == last_used_sq.c.client_id)
        .order_by(
            desc(last_used_sq.c.last_used).nulls_last(),
            Client.name,
        )
    )


def client_payload(client):
    """Canonical client shape shared by list, create, read and update."""
    return {'id': client.id, 'name': client.name, 'color': client.color}


def client_name_from_payload(data):
    """Trim and validate a client name without mutating the request object."""
    raw = data.get('name')
    if not isinstance(raw, str) or not raw.strip():
        return None, 'Client name is required'
    name = raw.strip()
    if len(name) > 80:
        return None, 'Client name must be 80 characters or fewer'
    return name, None


@app.route('/')
def index():
    return render_template('index.html', version=APP_VERSION)

@app.route('/clients', methods=['GET'])
def get_clients():
    query = request.args.get('query', '')
    q = clients_query_most_recent_first()
    if query:
        q = q.filter(Client.name.like(f'%{query}%'))
    clients = q.all()
    return jsonify([client_payload(client) for client in clients])

@app.route('/autocomplete', methods=['GET'])
def autocomplete():
    clients = clients_query_most_recent_first().all()
    results = [client.name for client in clients]
    return jsonify(results)

@app.route('/update_task_client', methods=['POST'])
def update_task_client():
    data = request.json
    client_name = data.get('client')
    today = date.today()
    
    if not client_name:
        return jsonify({'error': 'Client name is required'}), 400

    client = Client.query.filter_by(name=client_name).first()
    if not client:
        client = Client(name=client_name)
        db.session.add(client)
        db.session.commit()

    task = Task_Item.query.filter_by(date=today, end_time=None).first()
    if task:
        task.client_id = client.id
        db.session.commit()
        # The id comes back so the dashboard can re-point its works list at the
        # new client without a second round trip to look the name up.
        return jsonify({'success': True, 'client_id': client.id}), 200

    return jsonify({'error': 'No active task found'}), 404

@app.route('/clients', methods=['POST'])
def create_client():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    name, error = client_name_from_payload(data)
    if error:
        return jsonify({'error': error}), 400
    if Client.query.filter_by(name=name).first():
        return jsonify({'error': 'Client already exists'}), 400
    try:
        color = normalize_client_color(data.get('color') or random_client_color())
    except ValueError as error:
        return jsonify({'error': str(error)}), 400

    new_client = Client(name=name, color=color)
    db.session.add(new_client)
    db.session.commit()
    return jsonify(client_payload(new_client)), 201

@app.route('/clients/<int:id>', methods=['GET'])
def get_client(id):
    client = db.session.get(Client, id)
    if client is None:
        return jsonify({'error': 'Client not found'}), 404
    return jsonify(client_payload(client))

@app.route('/clients/<int:id>', methods=['PUT'])
def update_client(id):
    client = db.session.get(Client, id)
    if client is None:
        return jsonify({'error': 'Client not found'}), 404
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    name, error = client_name_from_payload(data)
    if error:
        return jsonify({'error': error}), 400
    duplicate = Client.query.filter(Client.name == name, Client.id != id).first()
    if duplicate:
        return jsonify({'error': 'Client already exists'}), 400
    try:
        color = normalize_client_color(data.get('color', client.color))
    except ValueError as error:
        return jsonify({'error': str(error)}), 400

    client.name = name
    client.color = color
    db.session.commit()
    return jsonify(client_payload(client))

@app.route('/clients/<int:id>', methods=['DELETE'])
def delete_client(id):
    client = Client.query.get(id)
    if client is None:
        return jsonify({'error': 'Client not found'}), 404
    Task_Item.query.filter(Task_Item.client_id == id).update(
        {Task_Item.client_id: None},
        synchronize_session=False,
    )
    # Works go with the client rather than being orphaned like tasks: tracked
    # time still means something under a "removed client" heading, a list of
    # what you did for a client that no longer exists does not. Deleted here by
    # hand because SQLite runs with foreign_keys OFF, which makes the model's
    # ondelete='CASCADE' documentation rather than enforcement.
    Work.query.filter(Work.client_id == id).delete(synchronize_session=False)
    ManualAdjustment.query.filter(ManualAdjustment.client_id == id).delete(
        synchronize_session=False
    )
    # Budgets go the same way as works, and for the same reason: a pot of hours
    # for a client that no longer exists has nothing to measure. Un-pin first —
    # the tasks survive as "removed client" time and must not be left pointing
    # at a budget row that's about to disappear.
    doomed = [b.id for b in Budget.query.filter(Budget.client_id == id).all()]
    if doomed:
        Task_Item.query.filter(Task_Item.budget_id.in_(doomed)).update(
            {Task_Item.budget_id: None},
            synchronize_session=False,
        )
        # Holds too, and explicitly: this is a *bulk* delete, which doesn't run
        # the ORM's delete-orphan cascade the way session.delete() does. Unlike
        # time entries there's nothing to preserve — a hold describes a budget
        # that's going, so it goes with it.
        BudgetHold.query.filter(BudgetHold.budget_id.in_(doomed)).delete(
            synchronize_session=False
        )
        Budget.query.filter(Budget.client_id == id).delete(synchronize_session=False)
    # Team budgets own imported entries and member mappings. Delete through the
    # ORM rather than a bulk query so their delete-orphan cascades still run on
    # SQLite, where ON DELETE CASCADE is documentation rather than enforcement.
    for team_budget in TeamBudget.query.filter(TeamBudget.client_id == id).all():
        db.session.delete(team_budget)
    db.session.delete(client)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/client_manager')
def client_manager():
    clients = Client.query.all()
    return render_template('client_manager.html', clients=clients, version=APP_VERSION)

@app.route('/new_client', methods=['GET', 'POST'])
def new_client():
    if request.method == 'POST':
        name = request.form['name']
        if not Client.query.filter_by(name=name).first():
            new_client = Client(name=name)
            db.session.add(new_client)
            db.session.commit()
            return redirect(url_for('client_manager'))
        return jsonify({'error': 'Client already exists'}), 400
    return render_template('new_client.html', version=APP_VERSION)

@app.route('/get_breaks', methods=['POST'])
def get_breaks():
    data = request.json
    submitted_date = data.get('date')
    if submitted_date:
        try:
            date_obj = datetime.strptime(submitted_date, '%Y-%m-%d').date()
            breaks = BreakTracking.query.filter(BreakTracking.date == date_obj).all()
            breaks_data = [{
                'id': break_item.id,
                'date': break_item.date.strftime('%Y-%m-%d'),
                'start_time': break_item.start_time.strftime('%H:%M:%S') if break_item.start_time else None,
                'end_time': break_item.end_time.strftime('%H:%M:%S') if break_item.end_time else None,
                'total_seconds': break_item.total_seconds
            } for break_item in breaks]
            return jsonify(breaks_data)
        except ValueError:
            return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400
    else:
        return jsonify({'error': 'Date is required.'}), 400
    
@app.route('/get_day_data', methods=['POST'])
def get_day_data():
    data = request.json
    submitted_date = data.get('date')
    if submitted_date:
        try:
            date_obj = datetime.strptime(submitted_date, '%Y-%m-%d').date()
            day_data = TimeTracking.query.filter(TimeTracking.date == date_obj).first()
            
            # Handle case where no TimeTracking entry exists
            if not day_data:
                return jsonify({
                    "start_time": None,
                    "end_time": None
                })
            
            day_data = {
                "start_time": day_data.start_time.strftime('%H:%M:%S') if day_data.start_time else None,
                "end_time": day_data.end_time.strftime('%H:%M:%S') if day_data.end_time else None,
            }
            return jsonify(day_data)
        except ValueError:
            return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400
    else:
        return jsonify({'error': 'Date is required.'}), 400

@app.route('/task_browser')
def task_browser():
    return render_template('task_browser.html', version=APP_VERSION)

# The parameter is `date_string`, not `date`: naming it `date` shadowed the
# `datetime.date` import for the length of the function, so anything in here
# that wanted today's date got a string instead.
@app.route('/tasks/<date_string>')
def get_tasks(date_string):
    date_obj = datetime.strptime(date_string, '%Y-%m-%d').date()
    tasks = Task_Item.query.filter_by(date=date_obj).all()
    # A task with no end is still running, and only today's can be. Substituting
    # the current clock into an *older* open row measured it from its start to
    # this afternoon — a Tuesday task reading as nineteen hours long. The
    # startup sweep closes those properly (see day_close.py); until it has, an
    # open past row reports its start time and therefore no duration, matching
    # task_duration_seconds().
    running_end = datetime.now().time() if date_obj == date.today() else None

    tasks_data = [{
        'id': task.id,
        'date': task.date.strftime('%Y-%m-%d'),
        'start_time': task.start_time.strftime('%H:%M:%S'),
        'end_time': (running_end or task.start_time).strftime('%H:%M:%S')
        if task.end_time is None else task.end_time.strftime('%H:%M:%S'),
        'client_id': task.client_id,
        'client_name': task_client_display_name(task),
        'client_color': task_client_color(task),
        'type': task.type,
        'description': task.description,
        'time_spent': task.time_spent,
        'adjust_entry': task.adjust_entry,
        'is_ongoing': task.end_time is None
    } for task in tasks]
    return jsonify(tasks_data)


@app.route('/api/client-day-total/<date_string>/<int:client_id>')
def get_client_day_total(date_string, client_id):
    """Logged and still-running time for one client-day.

    Today polls this endpoint while a task is running. Separating completed
    tasks from the active one keeps the header honest: elapsed time on the
    current task has not been logged yet.
    """
    try:
        day = datetime.strptime(date_string, '%Y-%m-%d').date()
    except ValueError:
        return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400

    now = datetime.now()
    tasks = Task_Item.query.filter_by(date=day, client_id=client_id).all()
    logged_seconds = sum(
        task_duration_seconds(task, now) for task in tasks if task.end_time is not None
    )
    unlogged_seconds = sum(
        task_duration_seconds(task, now) for task in tasks if task.end_time is None
    )
    tracked_seconds = logged_seconds + unlogged_seconds
    adjustment_input_seconds = (
        tracked_seconds // 60 * 60
        if any(task.end_time is None for task in tasks)
        else tracked_seconds
    )
    policy = _rounding_policy()
    adjustment = ManualAdjustment.query.filter_by(
        date=day, client_id=client_id
    ).first()
    figures = adjustment_figures(
        adjustment_input_seconds,
        adjustment.adjustment_minutes if adjustment else None,
        policy,
    )
    client = db.session.get(Client, client_id)

    return jsonify({
        'client_name': client.name if client else None,
        'has_running_task': any(task.end_time is None for task in tasks),
        'logged_minutes': logged_seconds / 60,
        'unlogged_minutes': unlogged_seconds / 60,
        'tracked_minutes': tracked_seconds / 60,
        'base_minutes': figures['base_seconds'] / 60,
        'adjustment_minutes': adjustment.adjustment_minutes if adjustment else None,
        'adjusted_minutes': figures['adjusted_seconds'] / 60,
        'rounded_hours': figures['billable_seconds'] / 3600,
        'rounding_enabled': policy['enabled'],
        'rounding_interval_minutes': policy['interval_minutes'],
        'rounding_direction': policy['direction'],
    })


def _manual_adjustment_payload(adjustment, policy=None, now=None):
    """Serialize one adjustment with live totals derived from its tasks."""
    policy = policy or _rounding_policy()
    now = now or datetime.now()
    tasks = Task_Item.query.filter_by(
        date=adjustment.date, client_id=adjustment.client_id
    ).all()
    has_running_task = any(task.end_time is None for task in tasks)
    tracked_seconds = sum(task_duration_seconds(task, now) for task in tasks)
    if has_running_task:
        tracked_seconds = tracked_seconds // 60 * 60
    figures = adjustment_figures(
        tracked_seconds, adjustment.adjustment_minutes, policy
    )
    client = adjustment.client
    return {
        'id': adjustment.id,
        'date': adjustment.date.isoformat(),
        'client_id': adjustment.client_id,
        'client_name': client.name if client else None,
        'client_color': client.color if client else None,
        'has_running_task': has_running_task,
        'tracked_minutes': figures['tracked_seconds'] / 60,
        'base_minutes': figures['base_seconds'] / 60,
        'adjustment_minutes': adjustment.adjustment_minutes,
        'adjusted_minutes': figures['adjusted_seconds'] / 60,
        'billable_minutes': figures['billable_seconds'] / 60,
    }


def _parse_adjustment_date(value):
    try:
        return datetime.strptime(value or '', '%Y-%m-%d').date(), None
    except (TypeError, ValueError):
        return None, 'Invalid date format. Use YYYY-MM-DD.'


def _parse_adjustment_minutes(value):
    if isinstance(value, bool):
        return None, 'Adjustment minutes must be a whole number.'
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return None, 'Adjustment minutes must be a whole number.'
    if str(value).strip() != str(minutes):
        return None, 'Adjustment minutes must be a whole number.'
    if minutes == 0:
        return None, 'Adjustment must be greater or less than zero.'
    return minutes, None


def _validate_adjustment_total(day, client_id, minutes):
    tasks = Task_Item.query.filter_by(date=day, client_id=client_id).all()
    tracked_seconds = sum(task_duration_seconds(task) for task in tasks)
    if any(task.end_time is None for task in tasks):
        tracked_seconds = tracked_seconds // 60 * 60
    try:
        adjustment_figures(tracked_seconds, minutes, _rounding_policy())
    except ValueError as error:
        return str(error)
    return None


@app.route('/api/manual-adjustments', methods=['GET'])
def api_list_manual_adjustments():
    day, error = _parse_adjustment_date(request.args.get('date'))
    if error:
        return jsonify({'error': error}), 400

    policy = _rounding_policy()
    rows = ManualAdjustment.query.filter_by(date=day).join(Client).order_by(
        Client.name
    ).all()
    return jsonify([_manual_adjustment_payload(row, policy) for row in rows])


@app.route('/api/manual-adjustments', methods=['POST'])
def api_create_manual_adjustment():
    data = request.get_json(silent=True) or {}
    day, error = _parse_adjustment_date(data.get('date'))
    if error:
        return jsonify({'error': error}), 400
    try:
        client_id = int(data.get('client_id'))
    except (TypeError, ValueError):
        return jsonify({'error': 'Client is required.'}), 400
    client = db.session.get(Client, client_id)
    if client is None:
        return jsonify({'error': 'Client not found.'}), 404
    minutes, error = _parse_adjustment_minutes(data.get('adjustment_minutes'))
    if error:
        return jsonify({'error': error}), 400
    if ManualAdjustment.query.filter_by(date=day, client_id=client_id).first():
        return jsonify({
            'error': 'This client already has an adjustment for the selected date.'
        }), 409
    error = _validate_adjustment_total(day, client_id, minutes)
    if error:
        return jsonify({'error': error}), 400

    adjustment = ManualAdjustment(
        date=day, client_id=client_id, adjustment_minutes=minutes
    )
    db.session.add(adjustment)
    db.session.commit()
    return jsonify(_manual_adjustment_payload(adjustment)), 201


@app.route('/api/manual-adjustments/<int:adjustment_id>', methods=['PUT'])
def api_update_manual_adjustment(adjustment_id):
    adjustment = db.session.get(ManualAdjustment, adjustment_id)
    if adjustment is None:
        return jsonify({'error': 'Manual adjustment not found.'}), 404
    data = request.get_json(silent=True) or {}
    minutes, error = _parse_adjustment_minutes(data.get('adjustment_minutes'))
    if error:
        return jsonify({'error': error}), 400
    error = _validate_adjustment_total(
        adjustment.date, adjustment.client_id, minutes
    )
    if error:
        return jsonify({'error': error}), 400

    adjustment.adjustment_minutes = minutes
    adjustment.updated_at = datetime.now()
    db.session.commit()
    return jsonify(_manual_adjustment_payload(adjustment))


@app.route('/api/manual-adjustments/<int:adjustment_id>', methods=['DELETE'])
def api_delete_manual_adjustment(adjustment_id):
    adjustment = db.session.get(ManualAdjustment, adjustment_id)
    if adjustment is None:
        return jsonify({'error': 'Manual adjustment not found.'}), 404
    db.session.delete(adjustment)
    db.session.commit()
    return jsonify({'success': True})


@app.route('/unfinished_tasks', methods=['GET'])
def get_unfinished_tasks():
    today = date.today()
    unfinished_tasks = Task_Item.query.filter_by(date=today, end_time=None).all()
    tasks_data = [{
        'id': task.id,
        'client': task_client_display_name(task),
        # client_id, not just the display name: the dashboard's works list is
        # keyed on it, and the name round-trip can't distinguish a real client
        # called "Removed client" from a deleted one.
        'client_id': task.client_id,
        'client_color': task_client_color(task),
        'start_time': task.start_time.strftime('%H:%M:%S')
    } for task in unfinished_tasks]
    return jsonify(tasks_data)

@app.route('/most_recent_task_end_time', methods=['GET'])
def get_most_recent_task_end_time():
    today = date.today()
    
    # Find the most recent completed task for today
    most_recent_task = Task_Item.query.filter(
        Task_Item.date == today,
        Task_Item.end_time.isnot(None)
    ).order_by(Task_Item.end_time.desc()).first()
    
    if most_recent_task and most_recent_task.end_time:
        return jsonify({
            'mostRecentTaskEndTime': most_recent_task.end_time.strftime('%H:%M')
        })
    else:
        # If no completed tasks today, return the day's start time
        day_start = TimeTracking.query.filter_by(date=today).first()
        if day_start and day_start.start_time:
            return jsonify({
                'mostRecentTaskEndTime': day_start.start_time.strftime('%H:%M')
            })
    
    # If no day start or completed tasks, return null
    return jsonify({
        'mostRecentTaskEndTime': None
    })

@app.route('/complete_task', methods=['POST'])
def complete_task():
    print("Completing task")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    client_name = data.get('client')
    end_time = data.get('endTime')
    type = data.get('type')
    print("submitted end time", end_time)
    try:
        datetime_obj = parse_clock_time(end_time)
    except ValueError:
        return jsonify({'error': 'Invalid end time format'}), 400
    date = datetime.now().date()

    if not client_name:
        print("no client name")
        return jsonify({'error': 'Client name is required'}), 400

    client = Client.query.filter_by(name=client_name).first()
    if not client:
        print("no client")
        client = Client(name=client_name)
        db.session.add(client)
        db.session.commit()

    existing_entry = Task_Item.query.filter_by(date=date, end_time = None).first()
    print("existing entry", existing_entry)
    if existing_entry:
        print("updating new entry")
        print("time to save", datetime_obj)
        existing_entry.client_id = client.id
        existing_entry.type = type
        existing_entry.end_time = datetime_obj
        db.session.commit()
        # The task is closed and described. Drop the countdown rather than
        # resetting it — the next tick finds nothing active anyway, and this
        # makes that immediate.
        reminder_service.clear()
        return jsonify({'success': True}), 201
    else:
        print("failed to find existing entry")
        return jsonify({'error': 'No existing entry'}), 400
      

@app.route('/add_unfinished_task', methods=['POST'])
def add_unfinished_task():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    client_name = data.get('client')
    now = datetime.now()
    start_date = now.date()
    start_time = data.get('startTime')
    print("submitted start time", start_time)
    try:
        datetime_obj = parse_clock_time(start_time)
    except ValueError:
        return jsonify({'error': 'Invalid start time format'}), 400


    client = Client.query.filter_by(name=client_name).first()
    if not client:
        client = Client(name=client_name)
        db.session.add(client)
        db.session.commit()

    new_task = Task_Item(
        date=start_date,
        start_time=datetime_obj,
        end_time=None,
        client=client,
        type=None,
        description=None,
        time_spent=0
    )

    print(new_task)
    db.session.add(new_task)
    db.session.commit()
    # A new task starts with nothing recorded against it, so the countdown
    # starts here: you get a full interval to add a work before the first nudge.
    reminder_service.mark_activity()
    return jsonify({'success': True}), 201

@app.route('/start_day', methods=['POST'])
def start_day():
    print("starting day")
    today = datetime.now().date()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    submitted_time = data.get('time')
    try:
        datetime_obj = parse_clock_time(submitted_time)
    except ValueError:
        return jsonify({'error': 'Invalid start time format'}), 400
    existing_entry = TimeTracking.query.filter_by(date=today).first()
    if existing_entry:
        return jsonify({'message': 'Day already started'}), 400

    new_entry = TimeTracking(date=today, start_time=datetime_obj)
    db.session.add(new_entry)
    db.session.commit()
    return jsonify({'message': 'Day started successfully'}), 201

@app.route('/end_day', methods=['PUT'])
def end_day():
    print("ending day")
    today = datetime.now().date()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    try:
        submitted_time = parse_clock_time(data.get('time'))
    except ValueError:
        return jsonify({'error': 'Invalid end time format'}), 400
    existing_entry = TimeTracking.query.filter_by(date=today).first()
    if not existing_entry:
        return jsonify({'error': 'Day has not been started yet'}), 400

    existing_entry.end_time = submitted_time
    db.session.commit()
    return jsonify({'message': 'Day ended successfully'}), 200

@app.route('/check_tasks_for_today')
def check_tasks_for_today():
    today = date.today()
    tasks_for_today = Task_Item.query.filter_by(date=today).all()
    return jsonify({'tasks_exist': bool(tasks_for_today)})

@app.route('/check_day_status')
def check_day_status():
    # Get today's date
    today = date.today()
    print(today)
    
    # Check if there are any task items (completed or incomplete) for today
    tasks_for_today = Task_Item.query.filter_by(date=today, end_time=None).all()
    day_started_status = TimeTracking.query.filter_by(date=today).all() ## will return 0 if day has not been started
    on_break_time_status = BreakTracking.query.filter(and_(BreakTracking.date == today, BreakTracking.start_time.isnot(None),BreakTracking.end_time == None )).all()
    print(TimeTracking.query.filter_by(pause_time=None).all())
    print(tasks_for_today)
    print("on break time status", on_break_time_status)

    day_ended_status = False
    if day_started_status:
        day_ended_query = TimeTracking.query.filter_by(date=today).all()
        print(day_ended_query, "day ended query")
        if day_ended_query[0].end_time != None:
            print("here")
            day_ended_status = True

    print("day ended status",day_ended_status)

    print(bool(len(day_started_status)>0 ), "day currently open status" )
    
    # Return a JSON response indicating whether there are any task items for today
    ## break time status works like this: checks 
    return jsonify({'dayStarted': bool(len(day_started_status)>0),'unfinishedTasksExist': bool(len(tasks_for_today)>0), 'dayEnded': day_ended_status, 'breakTimeStarted': bool(len(on_break_time_status)>0)})

@app.route('/reopen_day', methods=['PUT'])
def reopen_day():
    today = datetime.now().date()
    existing_entry = TimeTracking.query.filter_by(date=today).first()
    if existing_entry:
        # Clear the end time in the entry for the current day
        existing_entry.end_time = None
        db.session.commit()
        return jsonify({'message': 'Day reopened successfully'}), 200
    else:
        return jsonify({'error': 'Day has not been started yet'}), 400


# --------------------------------------------------------------------------
# Day close-out
#
# See day_close.py for the rules and why they are what they are. This half is
# the queries and the writes; every decision below is made there.
#
# The whole thing is scoped to dates strictly before today. Today's task is
# meant to be running and today's day is meant to be open — sweeping either
# would close the work the user is in the middle of.
# --------------------------------------------------------------------------


def _open_past_tasks(today):
    """Every task before today with no end time, oldest first."""
    return (
        Task_Item.query
        .filter(Task_Item.date < today, Task_Item.end_time.is_(None))
        .order_by(Task_Item.date, Task_Item.start_time, Task_Item.id)
        .all()
    )


def _day_end_times(dates):
    """``{date: end_time}`` for the days among ``dates`` that were ended.

    Days with no tracking row, or a row that was never ended, are simply absent
    — both mean "no recorded end", which is the only distinction the caller
    makes. A date with more than one tracking row (nothing in the schema forbids
    it) contributes its latest end.
    """
    if not dates:
        return {}

    rows = (
        db.session.query(TimeTracking.date, func.max(TimeTracking.end_time))
        .filter(TimeTracking.date.in_(list(dates)), TimeTracking.end_time.isnot(None))
        .group_by(TimeTracking.date)
        .all()
    )
    return {row[0]: row[1] for row in rows}


def _next_task_start(task):
    """Start of the earliest later task on the same day, or None.

    Ties are excluded rather than treated as "later": two tasks recorded with
    the same start time can't bound each other, and picking one arbitrarily
    would close this task at its own start.
    """
    return (
        db.session.query(func.min(Task_Item.start_time))
        .filter(
            Task_Item.date == task.date,
            Task_Item.id != task.id,
            Task_Item.start_time > task.start_time,
        )
        .scalar()
    )


def _auto_close_open_tasks(today):
    """Close the open past tasks whose end time can be derived. Returns the rest.

    The returned tasks are the ones only the user can answer for, in the order
    they'll be asked about.
    """
    tasks = _open_past_tasks(today)
    if not tasks:
        return []

    day_ends = _day_end_times({task.date for task in tasks})
    by_id = {task.id: task for task in tasks}

    auto, prompt = day_close.plan_open_tasks([
        day_close.OpenTask(
            id=task.id,
            date=task.date,
            start_time=task.start_time,
            next_start=_next_task_start(task),
            day_end=day_ends.get(task.date),
        )
        for task in tasks
    ])

    for closure in auto:
        by_id[closure.id].end_time = closure.end_time
    if auto:
        db.session.commit()
        logger.info(
            'Auto-closed %d open task(s): %s',
            len(auto),
            ', '.join(f'#{c.id} at {c.end_time} ({c.reason})' for c in auto),
        )

    return [by_id[task.id] for task in prompt]


def _open_task_json(task):
    return {
        'id': task.id,
        'date': task.date.strftime('%Y-%m-%d'),
        'client': task_client_display_name(task),
        'client_id': task.client_id,
        # The floor for the answer: a task cannot end before it began.
        'start_time': task.start_time.strftime('%H:%M'),
    }


def _cap_open_days(today):
    """End every past day that was never ended, at its last task's end time.

    Runs only once no open past task is left, so "the last task's end" is a real
    figure rather than whatever happened to have been completed. Days with
    nothing recorded against them are removed instead — along with any breaks
    filed under them, which have no meaning without a day and would otherwise be
    counted by `/get_breaks` against a day that no longer exists.
    """
    rows = (
        TimeTracking.query
        .filter(TimeTracking.date < today, TimeTracking.end_time.is_(None))
        .all()
    )
    if not rows:
        return {'closed': 0, 'deleted': 0}

    dates = {row.date for row in rows}
    task_rows = (
        db.session.query(
            Task_Item.date,
            func.count(Task_Item.id),
            func.max(Task_Item.end_time),
        )
        .filter(Task_Item.date.in_(list(dates)))
        .group_by(Task_Item.date)
        .all()
    )
    tasks_by_date = {row[0]: (row[1], row[2]) for row in task_rows}

    # Keyed by date, not by row: the plan is about days, and a duplicate
    # tracking row for one date has to receive the same treatment as its twin.
    rows_by_date = {}
    for row in rows:
        rows_by_date.setdefault(row.date, []).append(row)

    plan = day_close.plan_day_closures([
        day_close.OpenDay(
            date=day,
            # The earliest start among duplicate rows — the floor the derived
            # end is held above.
            start_time=min(
                (r.start_time for r in rows_by_date[day] if r.start_time is not None),
                default=None,
            ),
            has_tasks=tasks_by_date.get(day, (0, None))[0] > 0,
            last_task_end=tasks_by_date.get(day, (0, None))[1],
        )
        for day in sorted(dates)
    ])

    for day, end_time in plan.close:
        for row in rows_by_date[day]:
            row.end_time = end_time

    for day in plan.delete:
        BreakTracking.query.filter_by(date=day).delete(synchronize_session=False)
        for row in rows_by_date[day]:
            db.session.delete(row)

    db.session.commit()
    if plan.close or plan.delete:
        logger.info(
            'Capped %d open day(s), removed %d empty day(s)',
            len(plan.close), len(plan.delete),
        )
    return {'closed': len(plan.close), 'deleted': len(plan.delete)}


@app.route('/api/day-close/sweep', methods=['POST'])
def api_day_close_sweep():
    """Startup pass: derive what can be derived, then say what's left to ask.

    ``tasks`` empty means nothing needs a human, and the day capping has already
    run by the time this responds — the two halves are deliberately not
    separately callable, because a day capped before its tasks were closed would
    be capped at the wrong time and would look settled afterwards.

    POST rather than GET because it writes, but it is idempotent: a second call
    finds nothing left to derive and nothing left to cap, so a retried request
    is harmless.
    """
    today = date.today()
    pending = _auto_close_open_tasks(today)
    return jsonify({
        'tasks': [_open_task_json(task) for task in pending],
        'capped': None if pending else _cap_open_days(today),
    })


@app.route('/api/day-close/resolve', methods=['POST'])
def api_day_close_resolve():
    """Record the end time the user supplied for one open past task.

    Caps the days as soon as the last one is answered, so the sweep always
    finishes in the same request that completes it rather than waiting for the
    next launch.
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400

    task_id = data.get('task_id')
    if not isinstance(task_id, int):
        return jsonify({'error': 'task_id is required'}), 400

    try:
        end_time = parse_clock_time(data.get('end_time'))
    except ValueError:
        return jsonify({'error': 'Invalid end time format'}), 400

    today = date.today()
    task = Task_Item.query.get(task_id)
    if task is None:
        return jsonify({'error': 'That task no longer exists'}), 404
    if task.date >= today:
        return jsonify({'error': 'Only tasks before today are closed here'}), 400
    if task.end_time is not None:
        return jsonify({'error': 'That task has already been closed'}), 409
    if end_time < task.start_time:
        return jsonify({'error': 'End time is before the task started'}), 400

    task.end_time = end_time
    db.session.commit()

    remaining = _auto_close_open_tasks(today)
    return jsonify({
        'tasks': [_open_task_json(item) for item in remaining],
        'capped': None if remaining else _cap_open_days(today),
    })


@app.route('/start_break', methods=['POST'])
def start_break():
    today = datetime.now().date()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    submitted_time = data.get('time')
    try:
        datetime_obj = parse_clock_time(submitted_time)
    except ValueError:
        return jsonify({'error': 'Invalid break start time format'}), 400
    # Create a new entry for the break
    new_entry = BreakTracking(date=today, start_time=datetime_obj)
    db.session.add(new_entry)
    db.session.commit()
    return jsonify({'message': 'Break started successfully'}), 200

@app.route('/end_break', methods=['post'])
def end_break():
    today = datetime.now().date()
    existing_entry = BreakTracking.query.filter_by(date=today).first()
    print(existing_entry)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    submitted_time = data.get('time')
    print(submitted_time)
    try:
        datetime_obj = parse_clock_time(submitted_time)
    except ValueError:
        return jsonify({'error': 'Invalid break end time format'}), 400
    if existing_entry:
        print(datetime_obj)
        existing_entry.end_time = datetime_obj
        db.session.commit()

        return jsonify({'message': 'Break ended successfully'}), 200

    else:
        return jsonify({'error': 'Day has not been started yet'}), 400

@app.route('/get_time_tracking/<date_str>', methods=['GET'])
def get_time_tracking(date_str):
    try:
        date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()
    except ValueError:
        return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400

    time_tracking_entry = TimeTracking.query.filter_by(date=date_obj).first()

    if time_tracking_entry:
        entry_data = {
            'id': time_tracking_entry.id,
            'date': time_tracking_entry.date.strftime('%Y-%m-%d'),
            'start_time': time_tracking_entry.start_time.strftime('%H:%M:%S') if time_tracking_entry.start_time else None,
            'end_time': time_tracking_entry.end_time.strftime('%H:%M:%S') if time_tracking_entry.end_time else None,
            'offset': time_tracking_entry.offset,
            'pause_time': time_tracking_entry.pause_time.strftime('%H:%M:%S') if time_tracking_entry.pause_time else None
        }
        return jsonify(entry_data)
    else:
        return jsonify({'message': 'No time tracking entry found for the given date.'}), 404


@app.route('/most_recent_end_time', methods=['GET'])
def most_recent_end_time():
    today = date.today()
    most_recent_end_time = None

    try:
        # Get most recent task end time
        most_recent_task = Task_Item.query.filter_by(date=today)\
            .filter(Task_Item.end_time.isnot(None))\
            .order_by(Task_Item.end_time.desc()).first()

        # Get most recent break end time
        most_recent_break = BreakTracking.query.filter_by(date=today)\
            .filter(BreakTracking.end_time.isnot(None))\
            .order_by(BreakTracking.end_time.desc()).first()

        # Get today's start time
        today_start_time = TimeTracking.query.filter_by(date=today).first()

        # Initialize with task end time if exists
        if most_recent_task and most_recent_task.end_time:
            most_recent_end_time = most_recent_task.end_time

        # Update if break end time is more recent
        if most_recent_break and most_recent_break.end_time:
            if not most_recent_end_time or most_recent_break.end_time > most_recent_end_time:
                most_recent_end_time = most_recent_break.end_time

        # Update if day start time is more recent
        if today_start_time and today_start_time.start_time:
            if not most_recent_end_time or today_start_time.start_time > most_recent_end_time:
                most_recent_end_time = today_start_time.start_time

        return jsonify({
            'mostRecentEndTime': most_recent_end_time.strftime('%H:%M') if most_recent_end_time else None
        })

    except Exception as e:
        print(f"Error in most_recent_end_time: {str(e)}")
        return jsonify({'mostRecentEndTime': None}), 200
    
@app.route('/get_min_time', methods=['GET'])
def get_min_time():
    today = date.today()
    on_break_time_status = bool(len(TimeTracking.query.filter_by(date=today, start_time=None).all())>0) # returns 0 if the user is currently on a break
    tasks_exist_for_today = bool(len(Task_Item.query.filter_by(date=today).all())>0)
    incomplete_tasks_exist = bool(len(Task_Item.query.filter_by(date=today, end_time=None).all())>0)
    day_started_status = bool(len(TimeTracking.query.filter_by(date=today).all())>0)
    break_completed_status = bool(len(BreakTracking.query.filter_by(date=today).all())>0)

    print("Here")
    print("Day started status :", day_started_status)
    print("On break status :", on_break_time_status)
    print(day_started_status and on_break_time_status)

    if day_started_status and on_break_time_status:
        # If the user is on break, return the minimum time for the day
        break_start_time = TimeTracking.query.filter_by(date=today).first().pause_time.strftime('%H:%M')
        print("Min time for clock :", break_start_time)
        min_time = break_start_time
        print("Min time for clock with break :", min_time)
        return jsonify({'min_time': min_time})
    elif incomplete_tasks_exist:
        # If there are incomplete tasks, return the minimum time for the day
        min_time = Task_Item.query.filter_by(date=today, end_time=None).first().start_time.strftime('%H:%M')
        print("Min time for clock with incomplete task :", min_time)
        return jsonify({'min_time': min_time})
    elif tasks_exist_for_today:
        # If there are no incomplete tasks, return the minimum time for the day
        min_time = Task_Item.query.filter_by(date=today).order_by(desc(Task_Item.end_time)).first().end_time.strftime('%H:%M')
        print("Min time for clock with no incomplete tasks :", min_time)
        return jsonify({'min_time': min_time})
    elif day_started_status and not incomplete_tasks_exist:
        # If there are no incomplete tasks, return the minimum time for the day
        min_time = TimeTracking.query.filter_by(date=today).first().start_time.strftime('%H:%M')
        print("Min time for clock with no tasks yet :", min_time)
        return jsonify({'min_time': min_time})

        
    min_time = '00:00'
    return jsonify({'min_time': min_time})

@app.route('/summary')
def summary_page():
    return render_template(
        'time_summary.html',
        clients=Client.query.order_by(Client.name).all(),
        version=APP_VERSION,
    )


def task_duration_seconds(task, now=None):
    """How long a task ran, in seconds.

    Task_Item.time_spent is never populated (it's written as 0 on creation and
    never updated), so duration always has to be derived from the timestamps.

    An unfinished task on today's date is measured up to the current time; on
    any earlier date there's no sensible end, so it counts as zero rather than
    silently inventing time.

    That zero is now a backstop rather than the normal path — the startup sweep
    closes open past tasks against a real answer from the user (see
    `day_close.py`) — but it stays, because aggregation runs on the timer thread
    and from the admin views too, either of which can see the database in the
    window before a launch has swept it.
    """
    now = now or datetime.now()

    end = task.end_time
    if end is None:
        if task.date != now.date():
            return 0
        end = now.time()

    delta = (
        datetime.combine(task.date, end)
        - datetime.combine(task.date, task.start_time)
    ).total_seconds()

    # Guard against a corrupted row where end precedes start.
    return max(0, int(delta))


def tasks_between(start, end, client_id=None):
    query = Task_Item.query.filter(
        Task_Item.date >= start,
        Task_Item.date <= end,
    )
    if client_id is not None:
        query = query.filter(Task_Item.client_id == client_id)
    return query.all()


def _rounding_policy():
    """Snapshot the global policy for one calculation."""
    settings = user_settings.load_settings()
    return {
        'enabled': settings['rounding_enabled'],
        'interval_minutes': settings['rounding_interval_minutes'],
        'direction': settings['rounding_direction'],
    }


def bucket_by_client_and_day(start, end, now=None, client_id=None):
    """Tracked seconds keyed by (client name, date).

    Rounding has to happen at this granularity — one client, one day — because
    that's the unit the History page rounds at, and it's what actually gets
    billed. Rounding a whole week in one go would give a different (smaller)
    number than the sum of the days it's made of.
    """
    now = now or datetime.now()

    buckets = {}
    running = set()
    for task in tasks_between(start, end, client_id):
        key = (task_client_display_name(task), task.date)
        buckets[key] = buckets.get(key, 0) + task_duration_seconds(task, now)
        if task.end_time is None:
            running.add(key)

    policy = _rounding_policy()
    adjustments_query = ManualAdjustment.query.filter(
        ManualAdjustment.date >= start,
        ManualAdjustment.date <= end,
    )
    if client_id is not None:
        adjustments_query = adjustments_query.filter(
            ManualAdjustment.client_id == client_id
        )
    adjustments = adjustments_query.all()
    for adjustment in adjustments:
        if adjustment.client is None:
            continue
        key = (adjustment.client.name, adjustment.date)
        tracked_seconds = buckets.get(key, 0)
        if key in running:
            tracked_seconds = tracked_seconds // 60 * 60
        figures = adjustment_figures(
            tracked_seconds, adjustment.adjustment_minutes, policy
        )
        # Summary treats this value as actual time and applies the rounding
        # policy to it for billable time.  That is precisely the override
        # contract: adjusted actual is the new input to rounding.
        buckets[key] = figures['adjusted_seconds']
    return buckets


# --------------------------------------------------------------------------
# Summary dashboard
#
# The arithmetic lives in summary.py; this is the query layer and the HTTP
# surface over it. Two reads back the whole page, split by *what they describe*
# rather than by which card wants them:
#
#   /api/summary/calendar — one row per date in the calendar's visible month
#       grid. Deliberately independent of what is selected, because the grid
#       goes on painting amounts for dates outside the selection.
#   /api/summary/overview — the selected range, aggregated. Totals, the daily
#       series and the per-client rollup all come out of one call, so a card
#       can never disagree with the figure in the KPI strip above it.
#
# Budget health is not here: `/api/budgets` already returns every budget with
# its live figures, and the dashboard filters that to the ones the range
# touches. A second code path to the same numbers is how they start to differ.
# --------------------------------------------------------------------------

# A year, matching /api/work-calendar. Both are bounded because the window
# arrives as a URL parameter and the day loop is linear in its length.
SUMMARY_WINDOW_MAX_DAYS = 370


def _summary_window():
    """The `start`/`end` query parameters as dates, or a message to reject."""
    return summary_report.parse_window(
        request.args.get('start'),
        request.args.get('end'),
        SUMMARY_WINDOW_MAX_DAYS,
    )


def _summary_day_rows(start, end, weekdays=None, now=None, client_id=None):
    """Per-day billable figures for a window, capacity resolved alongside."""
    hours_per_day, work_days, overrides, schedule_history = _work_calendar_settings()

    def capacity_for(day):
        details = budget_allocation.workday_details(
            day, hours_per_day, work_days, overrides, schedule_history
        )
        return details['is_workday'], details['hours']

    rows = summary_report.day_rows(
        start,
        end,
        bucket_by_client_and_day(start, end, now, client_id),
        capacity_for,
        policy=_rounding_policy(),
        weekdays=weekdays,
    )
    client_details = {
        client.name: client
        for client in Client.query.with_entities(Client.id, Client.name, Client.color).all()
    }
    for row in rows:
        for client in row['clients']:
            details = client_details.get(client['client_name'])
            client['client_id'] = details.id if details else None
            client['client_color'] = details.color if details else None
    return rows


@app.route('/api/summary/calendar', methods=['GET'])
def api_summary_calendar():
    """Per-day billable amounts for the whole of the calendar grid's window."""
    start, end, error = _summary_window()
    if error:
        return jsonify({'error': error}), 400

    return jsonify({
        'currency': None,
        'rounding': _rounding_policy(),
        'start_date': start.isoformat(),
        'end_date': end.isoformat(),
        'days': _summary_day_rows(
            start,
            end,
            client_id=request.args.get('client_id', type=int),
        ),
    })


@app.route('/api/summary/overview', methods=['GET'])
def api_summary_overview():
    """Everything the dashboard shows about one selected range."""
    start, end, error = _summary_window()
    if error:
        return jsonify({'error': error}), 400

    weekdays, error = summary_report.parse_weekdays(request.args.get('weekdays'))
    if error:
        return jsonify({'error': error}), 400

    selected = _summary_day_rows(
        start,
        end,
        weekdays,
        client_id=request.args.get('client_id', type=int),
    )
    # Cut to the elapsed part once, here, and hand the same list to all three.
    # Days that haven't happened have no time on them but plenty of capacity,
    # and counting that capacity makes every mid-week reading look like a
    # shortfall. `days` ships cut too, so the trend chart plots exactly the
    # days the figures above it are taken over.
    rows = summary_report.elapsed(selected)
    clients = summary_report.client_rollup(rows)

    return jsonify({
        'currency': None,
        'rounding': _rounding_policy(),
        'start_date': start.isoformat(),
        'end_date': end.isoformat(),
        'weekdays': sorted(weekdays) if weekdays else None,
        'totals': summary_report.totals(rows, clients, selected=selected),
        'days': rows,
        'clients': clients,
    })

# --------------------------------------------------------------------------
# Budgets
#
# The maths lives in budgets.py; this is the HTTP surface over it. Two things
# to know before changing anything here:
#
#   * A budget stores no running total. Every read recomputes consumption from
#     the tasks, because entries are edited constantly and a cached figure
#     would go wrong silently.
#   * Consumption is only ever computed for a whole client at once. One
#     budget's usage depends on what its neighbours already absorbed, so
#     answering "how full is budget 7" means allocating that client's entire
#     set. `_client_allocation` is therefore the single entry point.
# --------------------------------------------------------------------------


def _work_calendar_settings():
    """Capacity settings sampled together so one calculation is consistent."""
    settings = user_settings.load_settings()
    return (
        settings['work_hours_per_day'],
        settings['work_days'],
        settings['work_calendar_overrides'],
        settings['work_schedule_history'],
    )


def _client_allocation(client_id, now=None, every_task=False):
    """Run the allocator over one client.

    Returns ``(budgets, used, split, unbudgeted, tasks, days)``. The tasks come back
    because callers need dates to fold the per-task ``split`` into per-day
    figures. ``days`` is the client-day rounding ledger.

    Normal budget reads are bounded to the client's overall budget window.
    Pinned entries outside that window are also included, together with every
    same-client entry on those dates: a client-day is the indivisible rounding
    boundary, so loading a pin without its neighbours would disagree with the
    company total. ``every_task=True`` is reserved for the unbudgeted-history
    endpoint, whose purpose genuinely requires the client's full history.
    """
    now = now or datetime.now()
    rounding_policy = _rounding_policy()

    budgets = Budget.query.filter(Budget.client_id == client_id).all()
    task_query = Task_Item.query.filter(Task_Item.client_id == client_id)
    if every_task:
        tasks = task_query.all()
    elif not budgets:
        tasks = []
    else:
        window_start = min(budget.start_date for budget in budgets)
        window_end = max(budget.end_date for budget in budgets)
        budget_ids = [budget.id for budget in budgets]
        pinned_dates = [
            pinned_date
            for (pinned_date,) in db.session.query(Task_Item.date).filter(
                Task_Item.client_id == client_id,
                Task_Item.budget_id.in_(budget_ids),
                or_(
                    Task_Item.date < window_start,
                    Task_Item.date > window_end,
                ),
            ).distinct().all()
        ]
        date_scope = Task_Item.date.between(window_start, window_end)
        if pinned_dates:
            date_scope = or_(date_scope, Task_Item.date.in_(pinned_dates))
        tasks = task_query.filter(date_scope).all()
    adjustment_query = ManualAdjustment.query.filter_by(client_id=client_id)
    if every_task:
        adjustment_rows = adjustment_query.all()
    elif not budgets:
        adjustment_rows = []
    else:
        adjustment_rows = adjustment_query.filter(
            ManualAdjustment.date >= window_start,
            ManualAdjustment.date <= window_end,
        ).all()
    adjustments = {
        row.date: row.adjustment_minutes for row in adjustment_rows
    }
    used, split, unbudgeted, days = budget_allocation.allocation_ledger(
        budgets,
        tasks,
        now,
        rounding_policy,
        manual_adjustments=adjustments,
    )
    return budgets, used, split, unbudgeted, tasks, days


def _day_hours_by_budget_ledger(ledger):
    """Fold billable destination shares into ``{budget_id: {date: hours}}``."""
    per_budget = {}
    for client_day in ledger:
        for destination in client_day['destinations']:
            budget_id = destination['budget_id']
            hours = destination['billable_hours']
            if destination['kind'] != 'budget' or budget_id is None or hours <= 0:
                continue
            days = per_budget.setdefault(budget_id, {})
            day = client_day['date']
            days[day] = days.get(day, 0.0) + hours
    return per_budget


def _summarise_one(budget, now=None, today=None):
    """One budget's live figures, after re-allocating its whole client.

    There is no cheaper correct version of this — a budget's fill depends on
    what its overlapping neighbours absorbed — so the write endpoints all come
    back through here rather than trying to patch a single row's numbers.
    """
    budgets, used, split, _unbudgeted, tasks, ledger = _client_allocation(budget.client_id, now)
    day_hours = _day_hours_by_budget_ledger(ledger)
    hours_per_day, work_days, overrides, schedule_history = _work_calendar_settings()
    return budget_allocation.summarise(
        budget,
        used.get(budget.id, 0.0),
        hours_per_day,
        today,
        holds=budget.holds,
        day_hours=day_hours.get(budget.id, {}),
        work_days=work_days,
        calendar_overrides=overrides,
        schedule_versions=schedule_history,
    )


def _summarise_client(client_id, now=None, today=None):
    """Every budget for one client, summarised. Cheapest correct unit of work."""
    budgets, used, split, _unbudgeted, tasks, ledger = _client_allocation(client_id, now)
    hours_per_day, work_days, overrides, schedule_history = _work_calendar_settings()
    day_hours = _day_hours_by_budget_ledger(ledger)
    return [
        budget_allocation.summarise(
            b,
            used.get(b.id, 0.0),
            hours_per_day,
            today,
            # `holds` is a relationship on the budget rows already in memory,
            # so this is one small query per budget rather than a new round of
            # allocation work.
            holds=b.holds,
            day_hours=day_hours.get(b.id, {}),
            work_days=work_days,
            calendar_overrides=overrides,
            schedule_versions=schedule_history,
        )
        for b in budgets
    ]


@app.route('/budgets')
def budgets_page():
    return render_template(
        'budgets.html',
        clients=Client.query.order_by(Client.name).all(),
        version=APP_VERSION,
    )


@app.route('/api/budgets', methods=['GET'])
def api_list_budgets():
    """Every budget with its live figures, optionally filtered to one client."""
    client_id = request.args.get('client_id', type=int)

    if client_id is not None:
        summaries = _summarise_client(client_id)
    else:
        summaries = []
        for (cid,) in db.session.query(Budget.client_id).distinct().all():
            summaries.extend(_summarise_client(cid))

    closed = [s for s in summaries if s['status'] == 'closed']
    live = [s for s in summaries if s['status'] != 'closed']
    live.sort(key=lambda s: (s['status'] == 'upcoming', s['end_date'], s['name']))
    closed.sort(key=lambda s: s['end_date'], reverse=True)

    return jsonify(live + closed)


@app.route('/api/budgets/for-client/<int:client_id>', methods=['GET'])
def api_budgets_for_client(client_id):
    """Only the budgets currently in force for a client — the Today widget.

    Filtered server-side rather than in the widget so the dashboard never
    downloads a client's whole budget history to show two meters.
    """
    active = [s for s in _summarise_client(client_id) if s['is_active']]
    active.sort(key=lambda s: (s['end_date'], s['name']))
    return jsonify(active)


def _budget_or_404(budget_id):
    budget = Budget.query.get(budget_id)
    return budget


@app.route('/api/budgets/<int:budget_id>', methods=['GET'])
def api_get_budget(budget_id):
    """One budget in full: figures, daily burn curve, and what fed it.

    The entry list is what makes overlapping budgets workable — it's where you
    see that a given afternoon landed on the wrong pot and pin it to the right
    one.
    """
    budget = _budget_or_404(budget_id)
    if budget is None:
        return jsonify({'error': 'Budget not found'}), 404

    now = datetime.now()
    budgets, used, split, _unbudgeted, task_rows, ledger = _client_allocation(
        budget.client_id, now
    )
    hours_per_day, work_days, overrides, schedule_history = _work_calendar_settings()

    day_hours = _day_hours_by_budget_ledger(ledger).get(budget.id, {})
    summary = budget_allocation.summarise(
        budget,
        used.get(budget.id, 0.0),
        hours_per_day,
        holds=budget.holds,
        day_hours=day_hours,
        work_days=work_days,
        calendar_overrides=overrides,
        schedule_versions=schedule_history,
    )

    # Rebuild the per-task view. A task that spilled appears in both budgets,
    # always with its real raw duration plus the raw slice that landed here;
    # billable rounding is exposed only on the client-day ledger below.
    tasks = {t.id: t for t in task_rows}
    raw_hours = budget_allocation.raw_hours_by_task(task_rows, now)
    held = budget_allocation.hold_days(budget.holds)
    entries = []
    for task_id, allocations in split.items():
        for allocated_budget_id, hours, pinned in allocations:
            if allocated_budget_id != budget.id or hours <= 0:
                continue
            task = tasks.get(task_id)
            if task is None:
                continue
            entries.append({
                'task_id': task.id,
                'date': task.date.isoformat(),
                'start_time': task.start_time.strftime('%H:%M') if task.start_time else None,
                'end_time': task.end_time.strftime('%H:%M') if task.end_time else None,
                # An entry is always shown as the raw duration the user
                # recorded. Its billable rounding belongs to the day ledger.
                'hours': round(raw_hours.get(task.id, 0.0), 6),
                'raw_hours': round(raw_hours.get(task.id, 0.0), 6),
                'raw_seconds': int(round(raw_hours.get(task.id, 0.0) * 3600)),
                'allocated_raw_hours': round(hours, 6),
                'allocated_raw_seconds': int(round(hours * 3600)),
                'pinned': pinned,
                # A task that spilled is the single most confusing thing the
                # allocator does, so it gets said out loud in the UI.
                'split': len([a for a in allocations if a[1] > 0]) > 1,
                'running': task.end_time is None,
                # Time recorded on a day the project was supposedly on hold.
                # Still counted — the hours have to reconcile — but flagged,
                # because it nearly always means the hold dates are wrong.
                'held': task.date in held,
            })

    entries.sort(key=lambda e: (e['date'], e['start_time'] or ''), reverse=True)

    excluded_tasks = sorted(
        (task for task in task_rows if task.budget_excluded),
        key=lambda task: (task.date, task.start_time, task.id),
        reverse=True,
    )
    unassigned_entries = [{
        'task_id': task.id,
        'date': task.date.isoformat(),
        'start_time': task.start_time.strftime('%H:%M') if task.start_time else None,
        'end_time': task.end_time.strftime('%H:%M') if task.end_time else None,
        'hours': round(raw_hours.get(task.id, 0.0), 6),
        'raw_hours': round(raw_hours.get(task.id, 0.0), 6),
        'raw_seconds': int(round(raw_hours.get(task.id, 0.0) * 3600)),
        'running': task.end_time is None,
    } for task in excluded_tasks]

    return jsonify({
        **summary,
        'burn': budget_allocation.burn_series(
            budget,
            day_hours,
            hours_per_day,
            holds=budget.holds,
            work_days=work_days,
            calendar_overrides=overrides,
            schedule_versions=schedule_history,
        ),
        'entries': entries,
        'unassigned_entries': unassigned_entries,
        'rounding_days': budget_allocation.rounding_days_for_budget(
            ledger, budget.id
        ),
        # Everything covering this client, so the re-pin dropdown can offer the
        # alternatives without a second request.
        'sibling_budgets': [
            {
                'id': b.id,
                'name': b.name,
                'start_date': b.start_date.isoformat(),
                'end_date': b.end_date.isoformat(),
            }
            for b in sorted(budgets, key=lambda b: (b.end_date, b.name))
        ],
    })


def _parse_budget_payload(data, partial=False):
    """Validate a create/update body. Returns (fields, error_message)."""
    fields = {}

    if not partial or 'name' in data:
        name = (data.get('name') or '').strip()
        if not name:
            return None, 'A budget needs a name.'
        if len(name) > 120:
            return None, 'That name is too long (120 characters max).'
        fields['name'] = name

    if not partial or 'client_id' in data:
        try:
            client_id = int(data.get('client_id'))
        except (TypeError, ValueError):
            return None, 'Choose a client for this budget.'
        if Client.query.get(client_id) is None:
            return None, 'That client no longer exists.'
        fields['client_id'] = client_id

    for key in ('start_date', 'end_date'):
        if not partial or key in data:
            try:
                fields[key] = datetime.strptime(data.get(key), '%Y-%m-%d').date()
            except (TypeError, ValueError):
                return None, 'Dates must be YYYY-MM-DD.'

    if not partial or 'budgeted_hours' in data:
        try:
            hours = float(data.get('budgeted_hours'))
        except (TypeError, ValueError):
            return None, 'Budgeted hours must be a number.'
        if hours <= 0:
            return None, 'Budgeted hours must be greater than zero.'
        if hours > 100000:
            return None, "That's more hours than anyone has. Check the figure."
        fields['budgeted_hours'] = round(hours, 2)

    if not partial or 'risk_threshold_percent' in data:
        try:
            threshold = float(data.get('risk_threshold_percent', 10.0))
        except (TypeError, ValueError):
            return None, 'At-risk threshold must be a percentage.'
        if not math.isfinite(threshold) or threshold < 0 or threshold > 100:
            return None, 'At-risk threshold must be between 0% and 100%.'
        fields['risk_threshold_percent'] = round(threshold, 2)

    if 'notes' in data:
        notes = (data.get('notes') or '').strip()
        fields['notes'] = notes or None

    return fields, None


@app.route('/api/budgets', methods=['POST'])
def api_create_budget():
    fields, error = _parse_budget_payload(request.get_json(silent=True) or {})
    if error:
        return jsonify({'error': error}), 400

    if fields['end_date'] < fields['start_date']:
        return jsonify({'error': 'The end date falls before the start date.'}), 400

    budget = Budget(**fields)
    db.session.add(budget)
    db.session.commit()

    return jsonify(_summarise_one(budget)), 201


@app.route('/api/budgets/<int:budget_id>', methods=['PUT'])
def api_update_budget(budget_id):
    budget = _budget_or_404(budget_id)
    if budget is None:
        return jsonify({'error': 'Budget not found'}), 404

    fields, error = _parse_budget_payload(request.get_json(silent=True) or {}, partial=True)
    if error:
        return jsonify({'error': error}), 400

    start = fields.get('start_date', budget.start_date)
    end = fields.get('end_date', budget.end_date)
    if end < start:
        return jsonify({'error': 'The end date falls before the start date.'}), 400

    moving_client = (
        'client_id' in fields and fields['client_id'] != budget.client_id
    )

    for key, value in fields.items():
        setattr(budget, key, value)

    if moving_client:
        # Pins are per client by construction — an entry for client A pinned to
        # a budget that has just moved to client B would keep contributing time
        # from the wrong client forever. Dropping them is the only honest
        # answer, and it's a rare enough edit to be worth the bluntness.
        Task_Item.query.filter(Task_Item.budget_id == budget.id).update(
            {Task_Item.budget_id: None}, synchronize_session=False
        )

    db.session.commit()

    return jsonify(_summarise_one(budget))


@app.route('/api/budgets/<int:budget_id>', methods=['DELETE'])
def api_delete_budget(budget_id):
    budget = _budget_or_404(budget_id)
    if budget is None:
        return jsonify({'error': 'Budget not found'}), 404

    # Un-pin by hand: SQLite runs with foreign_keys OFF, so the model's
    # ondelete='SET NULL' doesn't fire. Getting this wrong would leave entries
    # pointing at a dead id, which the allocator treats as unpinned anyway —
    # but only by accident, and the stale value would resurrect if the id were
    # ever reused.
    Task_Item.query.filter(Task_Item.budget_id == budget.id).update(
        {Task_Item.budget_id: None}, synchronize_session=False
    )
    # Holds go with the budget, via the relationship's delete-orphan cascade —
    # session.delete() runs it, unlike the bulk delete in delete_client().
    db.session.delete(budget)
    db.session.commit()
    return jsonify({'success': True})


@app.route('/api/budgets/<int:budget_id>/close', methods=['POST'])
def api_close_budget(budget_id):
    """Close a live budget without erasing its originally scheduled end date."""
    budget = _budget_or_404(budget_id)
    if budget is None:
        return jsonify({'error': 'Budget not found'}), 404
    if budget.closed_at is not None:
        return jsonify({'error': 'This budget is already closed.'}), 409

    today = date.today()
    if today < budget.start_date:
        return jsonify({'error': 'An upcoming budget cannot be closed.'}), 400
    if today > budget.end_date:
        return jsonify({'error': 'This budget has already ended.'}), 409

    budget.closed_at = datetime.now()
    db.session.commit()
    return jsonify(_summarise_one(budget))


@app.route('/api/budgets/<int:budget_id>/reopen', methods=['POST'])
def api_reopen_budget(budget_id):
    """Undo a manual close. The budget goes back to whatever its dates and
    holds already imply — active if today is still inside its range, ended
    again if the range has since passed."""
    budget = _budget_or_404(budget_id)
    if budget is None:
        return jsonify({'error': 'Budget not found'}), 404
    if budget.closed_at is None:
        return jsonify({'error': 'This budget is not closed.'}), 409

    budget.closed_at = None
    db.session.commit()
    return jsonify(_summarise_one(budget))


# --------------------------------------------------------------------------
# Holds
#
# A hold is a stretch of a budget's range during which the project was paused.
# The arithmetic is entirely in budgets.py — held days are zero-capacity days,
# like weekends — so these endpoints only have to store honest intervals.
#
# Deliberately separate rows rather than fields on the budget: a project can be
# paused more than once, and a hold is very often recorded after the fact,
# neither of which a pair of columns can express.
# --------------------------------------------------------------------------


def _hold_json(hold):
    return {
        'id': hold.id,
        'budget_id': hold.budget_id,
        'start_date': hold.start_date.isoformat(),
        'end_date': hold.end_date.isoformat() if hold.end_date else None,
        'reason': hold.reason,
    }


def _parse_hold_payload(data, partial=False):
    """Validate a hold body. Returns (fields, error_message).

    ``end_date`` is explicitly three-valued: absent means "don't change it",
    ``null`` means "this hold is still running", and a date means it ended.
    Collapsing the first two would make resuming a project impossible to
    distinguish from editing its start date.
    """
    fields = {}

    if not partial or 'start_date' in data:
        try:
            fields['start_date'] = datetime.strptime(
                data.get('start_date'), '%Y-%m-%d'
            ).date()
        except (TypeError, ValueError):
            return None, 'Dates must be YYYY-MM-DD.'

    if 'end_date' in data:
        raw = data.get('end_date')
        if raw is None or raw == '':
            fields['end_date'] = None
        else:
            try:
                fields['end_date'] = datetime.strptime(raw, '%Y-%m-%d').date()
            except (TypeError, ValueError):
                return None, 'Dates must be YYYY-MM-DD.'

    if 'reason' in data:
        reason = (data.get('reason') or '').strip()
        if len(reason) > 200:
            return None, 'That reason is too long (200 characters max).'
        fields['reason'] = reason or None

    return fields, None


def _overlapping_hold(budget, start, end, ignore_id=None):
    """An existing hold on this budget that overlaps [start, end].

    Rejected rather than merged. Overlaps don't break the maths —
    ``hold_days`` is a set, so a doubly-held day is held once — but they're
    almost always a mis-click, and silently absorbing one would leave the user
    with a hold list that doesn't match what they thought they entered.
    """
    open_end = date.max
    for hold in budget.holds:
        if ignore_id is not None and hold.id == ignore_id:
            continue
        other_end = hold.end_date or open_end
        if hold.start_date <= (end or open_end) and start <= other_end:
            return hold
    return None


@app.route('/api/budgets/<int:budget_id>/holds', methods=['POST'])
def api_create_hold(budget_id):
    """Put a budget on hold, or record a past pause.

    ``end_date: null`` (or omitted) means the project is on hold right now and
    the resumption date isn't known yet. That's the common case — you pause
    when the work stops, not when you've been told when it restarts.
    """
    budget = _budget_or_404(budget_id)
    if budget is None:
        return jsonify({'error': 'Budget not found'}), 404

    fields, error = _parse_hold_payload(request.get_json(silent=True) or {})
    if error:
        return jsonify({'error': error}), 400

    start = fields['start_date']
    end = fields.get('end_date')
    if end is not None and end < start:
        return jsonify({'error': 'The hold ends before it starts.'}), 400

    # A hold entirely outside the budget's range would silently do nothing,
    # which reads as the feature being broken. Partial overlap is fine and
    # common — a pause that ran past the end date is a real thing.
    if start > budget.end_date or (end is not None and end < budget.start_date):
        return jsonify({
            'error': "That hold falls outside this budget's dates, so it wouldn't change anything."
        }), 400

    clash = _overlapping_hold(budget, start, end)
    if clash is not None:
        return jsonify({
            'error': f'That overlaps an existing hold starting {clash.start_date.isoformat()}.'
        }), 400

    hold = BudgetHold(budget_id=budget.id, **fields)
    db.session.add(hold)
    db.session.commit()

    return jsonify({'hold': _hold_json(hold), 'budget': _summarise_one(budget)}), 201


@app.route('/api/budgets/<int:budget_id>/holds/<int:hold_id>', methods=['PUT'])
def api_update_hold(budget_id, hold_id):
    """Edit a hold — most often to end an open one, which is "resume"."""
    budget = _budget_or_404(budget_id)
    if budget is None:
        return jsonify({'error': 'Budget not found'}), 404

    hold = BudgetHold.query.get(hold_id)
    if hold is None or hold.budget_id != budget.id:
        return jsonify({'error': 'Hold not found'}), 404

    fields, error = _parse_hold_payload(request.get_json(silent=True) or {}, partial=True)
    if error:
        return jsonify({'error': error}), 400

    start = fields.get('start_date', hold.start_date)
    end = fields['end_date'] if 'end_date' in fields else hold.end_date
    if end is not None and end < start:
        return jsonify({'error': 'The hold ends before it starts.'}), 400

    clash = _overlapping_hold(budget, start, end, ignore_id=hold.id)
    if clash is not None:
        return jsonify({
            'error': f'That overlaps an existing hold starting {clash.start_date.isoformat()}.'
        }), 400

    for key, value in fields.items():
        setattr(hold, key, value)
    db.session.commit()

    return jsonify({'hold': _hold_json(hold), 'budget': _summarise_one(budget)})


@app.route('/api/budgets/<int:budget_id>/holds/<int:hold_id>', methods=['DELETE'])
def api_delete_hold(budget_id, hold_id):
    """Remove a hold entirely — the undo for having recorded one by mistake.

    Distinct from ending a hold: resuming keeps the dead days out of the
    capacity, deleting says they were never dead at all.
    """
    budget = _budget_or_404(budget_id)
    if budget is None:
        return jsonify({'error': 'Budget not found'}), 404

    hold = BudgetHold.query.get(hold_id)
    if hold is None or hold.budget_id != budget.id:
        return jsonify({'error': 'Hold not found'}), 404

    db.session.delete(hold)
    db.session.commit()
    return jsonify({'success': True, 'budget': _summarise_one(budget)})


@app.route('/api/tasks/<int:task_id>/budget', methods=['PUT'])
def api_assign_task_budget(task_id):
    """Pin an entry, release it to the allocator, or exclude it from budgets.

    `{"budget_id": null}` is the release, and it's the important half — a pin
    the user can't undo would be worse than no pin at all.
    """
    task = Task_Item.query.get(task_id)
    if task is None:
        return jsonify({'error': 'Time entry not found'}), 404

    data = request.get_json(silent=True) or {}
    if 'budget_id' not in data:
        return jsonify({'error': 'Expected a budget_id (null to unpin).'}), 400

    raw = data['budget_id']
    if raw == 'none':
        task.budget_id = None
        task.budget_excluded = True
    elif raw is None:
        task.budget_id = None
        task.budget_excluded = False
    else:
        try:
            budget_id = int(raw)
        except (TypeError, ValueError):
            return jsonify({'error': 'budget_id must be a number, null, or "none".'}), 400

        budget = Budget.query.get(budget_id)
        if budget is None:
            return jsonify({'error': 'That budget no longer exists.'}), 404
        if budget.client_id != task.client_id:
            return jsonify({
                'error': "That budget belongs to a different client."
            }), 400
        task.budget_id = budget_id
        task.budget_excluded = False

    db.session.commit()

    # The whole client is re-summarised because moving one entry changes what
    # spills where across every overlapping budget.
    return jsonify({
        'success': True,
        'budgets': _summarise_client(task.client_id),
    })


@app.route('/api/budgets/unbudgeted/<int:client_id>', methods=['GET'])
def api_unbudgeted_hours(client_id):
    """Hours recorded for a client on days no budget covers.

    Surfaced because the gap is the thing you can't see from the budgets
    themselves: a period nobody wrote a budget for looks identical to a period
    with nothing recorded in it.

    Scans the client's whole history rather than the budgeted window — time
    recorded before the first budget started or after the last one ended is
    exactly the kind of gap worth knowing about, and it's the kind the scoped
    query is blind to by construction.
    """
    _b, _used, _split, unbudgeted, _tasks, _ledger = _client_allocation(
        client_id, every_task=True
    )
    return jsonify({'client_id': client_id, 'unbudgeted_hours': round(unbudgeted, 2)})


# --------------------------------------------------------------------------
# Team budgets
#
# These engagements are fed only by imported XLSX rows. They intentionally do
# not call the personal allocator, read Task_Item, or inherit local rounding
# and calendar settings.
# --------------------------------------------------------------------------


TEAM_IMPORT_MAX_BYTES = 10 * 1024 * 1024


def _team_budget_or_404(team_budget_id):
    return db.session.get(TeamBudget, team_budget_id)


def _team_member_record(member):
    return {
        'id': member.id,
        'source_user_id': member.source_user_id,
        'display_name': member.display_name,
        'name': member.name,
        'budgeted_hours': float(member.budgeted_hours),
        'aliases': [alias.source_user_id for alias in member.aliases],
    }


def _team_budget_json(team_budget, detail=False, today=None):
    today = today or date.today()
    member_records = [_team_member_record(member) for member in team_budget.members]
    entry_count = db.session.query(func.count(TeamBudgetEntry.id)).filter(
        TeamBudgetEntry.team_budget_id == team_budget.id
    ).scalar() or 0
    if detail:
        aggregates = db.session.query(
            TeamBudgetEntry.member_id,
            TeamBudgetEntry.work_date,
            func.sum(TeamBudgetEntry.time_seconds),
        ).filter(
            TeamBudgetEntry.team_budget_id == team_budget.id
        ).group_by(
            TeamBudgetEntry.member_id, TeamBudgetEntry.work_date
        ).all()
        entry_records = [
            {'member_id': member_id, 'date': work_date, 'seconds': seconds}
            for member_id, work_date, seconds in aggregates
        ]
    else:
        latest_date = db.session.query(func.max(TeamBudgetEntry.work_date)).filter(
            TeamBudgetEntry.team_budget_id == team_budget.id
        ).scalar()
        aggregates = db.session.query(
            TeamBudgetEntry.member_id,
            func.sum(TeamBudgetEntry.time_seconds),
        ).filter(
            TeamBudgetEntry.team_budget_id == team_budget.id
        ).group_by(TeamBudgetEntry.member_id).all()
        entry_records = [
            {'member_id': member_id, 'date': latest_date, 'seconds': seconds}
            for member_id, seconds in aggregates
        ] if latest_date else []
    summary = team_budget_reporting.summarise_team_budget(
        team_budget.start_date,
        team_budget.end_date,
        member_records,
        entry_records,
        today=today,
        closed_at=team_budget.closed_at,
    )
    if detail:
        member_entry_counts = dict(db.session.query(
            TeamBudgetEntry.member_id,
            func.count(TeamBudgetEntry.id),
        ).filter(
            TeamBudgetEntry.team_budget_id == team_budget.id
        ).group_by(TeamBudgetEntry.member_id).all())
        policy = _rounding_policy()
        seconds_by_member_day = {}
        raw_seconds_by_member = {}
        for entry in entry_records:
            member_id = entry['member_id']
            key = (member_id, entry['date'])
            seconds_by_member_day[key] = (
                seconds_by_member_day.get(key, 0) + int(entry['seconds'])
            )
            raw_seconds_by_member[member_id] = (
                raw_seconds_by_member.get(member_id, 0) + int(entry['seconds'])
            )
        rounded_hours_by_member = {}
        for (member_id, _work_date), seconds in seconds_by_member_day.items():
            rounded_hours_by_member[member_id] = (
                rounded_hours_by_member.get(member_id, 0)
                + round_seconds_to_hours(seconds, policy)
            )
        for member in summary['members']:
            member_id = member['id']
            budget_seconds = round(float(member['budgeted_hours']) * 3600)
            used_seconds = raw_seconds_by_member.get(member_id, 0)
            display_used = rounded_hours_by_member.get(member_id, 0.0)
            member['budget_seconds'] = budget_seconds
            member['used_seconds'] = used_seconds
            member['remaining_seconds'] = budget_seconds - used_seconds
            member['entry_count'] = member_entry_counts.get(member_id, 0)
            member['display_used_hours'] = round(display_used, 6)
            member['display_remaining_hours'] = round(
                float(member['budgeted_hours']) - display_used, 6
            )
    if not detail:
        summary.pop('burn', None)
        summary.pop('member_burn', None)
        summary.pop('weekly', None)
        summary.pop('member_weekly', None)

    return {
        'id': team_budget.id,
        'name': team_budget.name,
        'client_id': team_budget.client_id,
        'client_name': team_budget.client.name if team_budget.client else None,
        'client_color': team_budget.client.color if team_budget.client else None,
        'start_date': team_budget.start_date.isoformat(),
        'end_date': team_budget.end_date.isoformat(),
        'notes': team_budget.notes,
        'closed_at': (
            team_budget.closed_at.isoformat() if team_budget.closed_at else None
        ),
        'started': today >= team_budget.start_date,
        'entry_count': entry_count,
        'imported_at': (
            team_budget.imported_at.isoformat() if team_budget.imported_at else None
        ),
        'import_filename': team_budget.import_filename,
        'import_sha256': team_budget.import_sha256,
        'import_row_count': team_budget.import_row_count,
        'import_skipped_count': team_budget.import_skipped_count,
        **summary,
    }


def _parse_team_members(raw_members):
    if not isinstance(raw_members, list) or not raw_members:
        return None, 'Add at least one team member.'

    members = []
    seen = set()
    for index, raw in enumerate(raw_members, start=1):
        if not isinstance(raw, dict):
            return None, f'Team member {index} is invalid.'
        source_user_id = str(raw.get('source_user_id') or '').strip()
        if not source_user_id:
            return None, f'Team member {index} needs an imported user ID.'
        if len(source_user_id) > 200:
            return None, f'Team member {index} has a user ID over 200 characters.'
        key = source_user_id.casefold()
        if key in seen:
            return None, f'The user ID {source_user_id!r} is listed more than once.'
        seen.add(key)

        display_name = str(raw.get('display_name') or '').strip()
        if len(display_name) > 120:
            return None, f'Team member {index} has a name over 120 characters.'
        try:
            if isinstance(raw.get('budgeted_hours'), bool):
                raise ValueError
            budgeted_hours = float(raw.get('budgeted_hours'))
        except (TypeError, ValueError):
            return None, f'Team member {index} needs numeric budgeted hours.'
        if not math.isfinite(budgeted_hours) or budgeted_hours <= 0:
            return None, f'Team member {index} needs budgeted hours above zero.'
        if budgeted_hours > 100000:
            return None, f'Team member {index} has too many budgeted hours.'

        member_id = raw.get('id')
        if member_id is not None:
            try:
                member_id = int(member_id)
            except (TypeError, ValueError):
                return None, f'Team member {index} has an invalid ID.'
        members.append({
            'id': member_id,
            'source_user_id': source_user_id,
            'display_name': display_name or None,
            'budgeted_hours': round(budgeted_hours, 2),
        })
    return members, None


def _parse_team_budget_payload(data, partial=False):
    if not isinstance(data, dict):
        return None, None, 'JSON object required.'
    fields = {}
    members = None

    if not partial or 'name' in data:
        name = str(data.get('name') or '').strip()
        if not name:
            return None, None, 'A team budget needs a name.'
        if len(name) > 120:
            return None, None, 'That name is too long (120 characters max).'
        fields['name'] = name

    if not partial or 'client_id' in data:
        try:
            client_id = int(data.get('client_id'))
        except (TypeError, ValueError):
            return None, None, 'Choose a client for this team budget.'
        if db.session.get(Client, client_id) is None:
            return None, None, 'That client no longer exists.'
        fields['client_id'] = client_id

    for key in ('start_date', 'end_date'):
        if not partial or key in data:
            try:
                fields[key] = date.fromisoformat(str(data.get(key) or ''))
            except ValueError:
                return None, None, 'Dates must be YYYY-MM-DD.'

    if 'notes' in data:
        notes = str(data.get('notes') or '').strip()
        if len(notes) > 2000:
            return None, None, 'Notes are limited to 2,000 characters.'
        fields['notes'] = notes or None

    if not partial or 'members' in data:
        members, error = _parse_team_members(data.get('members'))
        if error:
            return None, None, error

    return fields, members, None


def _apply_team_members(team_budget, member_fields):
    """Apply a complete member list, preserving import-bearing members."""
    existing = {member.id: member for member in team_budget.members}
    retained_ids = set()
    targets = []
    for fields in member_fields:
        member_id = fields['id']
        if member_id is None:
            member = TeamBudgetMember(team_budget=team_budget)
        else:
            member = existing.get(member_id)
            if member is None:
                return 'A team member no longer belongs to this budget.'
            if member_id in retained_ids:
                return 'A team member was submitted more than once.'
            retained_ids.add(member_id)
        targets.append((member, fields))

    removed = [member for member_id, member in existing.items() if member_id not in retained_ids]
    for member in removed:
        if TeamBudgetEntry.query.filter_by(member_id=member.id).first() is not None:
            return (
                f'{member.name} has imported time and cannot be removed. '
                'Import a replacement workbook without that person first.'
            )

    primary_owners = {
        fields['source_user_id'].casefold(): member
        for member, fields in targets
    }
    aliases_to_remove = []
    for member, _fields in targets:
        if member.id is None:
            continue
        for alias in member.aliases:
            owner = primary_owners.get(alias.source_user_id.casefold())
            if owner is not None and owner is not member:
                return f'The imported user ID {alias.source_user_id!r} is already mapped.'
            if owner is member:
                aliases_to_remove.append(alias)

    for alias in aliases_to_remove:
        db.session.delete(alias)
    for member in removed:
        db.session.delete(member)
    for member, fields in targets:
        old_source_id = member.source_user_id
        if (
            member.id is not None
            and old_source_id.casefold() != fields['source_user_id'].casefold()
            and old_source_id.casefold() not in primary_owners
            and TeamBudgetEntry.query.filter_by(member_id=member.id).first() is not None
        ):
            db.session.add(TeamBudgetMemberAlias(
                team_budget_id=team_budget.id,
                member=member,
                source_user_id=old_source_id,
            ))
        member.source_user_id = fields['source_user_id']
        member.display_name = fields['display_name']
        member.budgeted_hours = fields['budgeted_hours']
        if member.id is None:
            db.session.add(member)
    return None


@app.route('/api/team-budgets', methods=['GET'])
def api_list_team_budgets():
    client_id = request.args.get('client_id', type=int)
    query = TeamBudget.query
    if client_id is not None:
        query = query.filter(TeamBudget.client_id == client_id)
    budgets = [_team_budget_json(item) for item in query.all()]
    budgets.sort(key=lambda item: (
        item['status'] == 'closed',
        item['status'] == 'upcoming',
        item['end_date'],
        item['name'].casefold(),
    ))
    return jsonify(budgets)


@app.route('/api/team-budgets/<int:team_budget_id>', methods=['GET'])
def api_get_team_budget(team_budget_id):
    team_budget = _team_budget_or_404(team_budget_id)
    if team_budget is None:
        return jsonify({'error': 'Team budget not found'}), 404
    return jsonify(_team_budget_json(team_budget, detail=True))


@app.route('/api/team-budgets', methods=['POST'])
def api_create_team_budget():
    fields, members, error = _parse_team_budget_payload(request.get_json(silent=True))
    if error:
        return jsonify({'error': error}), 400
    if fields['end_date'] < fields['start_date']:
        return jsonify({'error': 'The end date falls before the start date.'}), 400

    team_budget = TeamBudget(**fields)
    db.session.add(team_budget)
    for member in members:
        member.pop('id', None)
        team_budget.members.append(TeamBudgetMember(**member))
    db.session.commit()
    return jsonify(_team_budget_json(team_budget)), 201


@app.route('/api/team-budgets/<int:team_budget_id>', methods=['PUT'])
def api_update_team_budget(team_budget_id):
    team_budget = _team_budget_or_404(team_budget_id)
    if team_budget is None:
        return jsonify({'error': 'Team budget not found'}), 404
    fields, members, error = _parse_team_budget_payload(
        request.get_json(silent=True), partial=True
    )
    if error:
        return jsonify({'error': error}), 400
    start = fields.get('start_date', team_budget.start_date)
    end = fields.get('end_date', team_budget.end_date)
    if end < start:
        return jsonify({'error': 'The end date falls before the start date.'}), 400
    outside_entry = TeamBudgetEntry.query.filter(
        TeamBudgetEntry.team_budget_id == team_budget.id,
        or_(TeamBudgetEntry.work_date < start, TeamBudgetEntry.work_date > end),
    ).first()
    if outside_entry is not None:
        return jsonify({
            'error': (
                'That period would exclude imported time. Reimport with Skip outside '
                'dates, or keep a period covering every imported row.'
            )
        }), 409
    if members is not None:
        error = _apply_team_members(team_budget, members)
        if error:
            db.session.rollback()
            return jsonify({'error': error}), 409
    for key, value in fields.items():
        setattr(team_budget, key, value)
    db.session.commit()
    return jsonify(_team_budget_json(team_budget))


@app.route('/api/team-budgets/<int:team_budget_id>', methods=['DELETE'])
def api_delete_team_budget(team_budget_id):
    team_budget = _team_budget_or_404(team_budget_id)
    if team_budget is None:
        return jsonify({'error': 'Team budget not found'}), 404
    db.session.delete(team_budget)
    db.session.commit()
    return jsonify({'success': True})


@app.route('/api/team-budgets/<int:team_budget_id>/close', methods=['POST'])
def api_close_team_budget(team_budget_id):
    """Manually close a live team engagement without changing its date range."""
    team_budget = _team_budget_or_404(team_budget_id)
    if team_budget is None:
        return jsonify({'error': 'Team budget not found'}), 404
    if team_budget.closed_at is not None:
        return jsonify({'error': 'This team budget is already closed.'}), 409

    today = date.today()
    if today < team_budget.start_date:
        return jsonify({'error': 'An upcoming team budget cannot be closed.'}), 400
    if today > team_budget.end_date:
        return jsonify({'error': 'This team budget has already ended.'}), 409

    team_budget.closed_at = datetime.now()
    db.session.commit()
    return jsonify(_team_budget_json(team_budget))


@app.route('/api/team-budgets/<int:team_budget_id>/reopen', methods=['POST'])
def api_reopen_team_budget(team_budget_id):
    """Undo a manual close and return the engagement to its dated state."""
    team_budget = _team_budget_or_404(team_budget_id)
    if team_budget is None:
        return jsonify({'error': 'Team budget not found'}), 404
    if team_budget.closed_at is None:
        return jsonify({'error': 'This team budget is not manually closed.'}), 409

    team_budget.closed_at = None
    db.session.commit()
    return jsonify(_team_budget_json(team_budget))


def _read_team_workbook_upload():
    upload = request.files.get('file')
    if upload is None or not upload.filename:
        raise ValueError('Choose an .xlsx workbook.')
    filename = Path(upload.filename).name
    if Path(filename).suffix.casefold() != '.xlsx':
        raise ValueError('Only .xlsx workbooks can be imported.')
    data = upload.stream.read(TEAM_IMPORT_MAX_BYTES + 1)
    if len(data) > TEAM_IMPORT_MAX_BYTES:
        raise ValueError('Workbooks are limited to 10 MB.')
    if not data:
        raise ValueError('That workbook is empty.')
    return data, filename, hashlib.sha256(data).hexdigest()


def _team_form_json(name, default):
    raw = request.form.get(name)
    if raw in (None, ''):
        return default
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f'{name} must be valid JSON.') from exc
    return value


def _team_source_map(team_budget):
    result = {}
    for member in team_budget.members:
        result[member.source_user_id.casefold()] = member
        for alias in member.aliases:
            result[alias.source_user_id.casefold()] = member
    return result


def _parse_team_upload(data):
    time_format = request.form.get('time_format', 'decimal_hours')
    sheet_name = request.form.get('sheet') or None
    mapping = _team_form_json('column_mapping', None)
    if mapping is not None and not isinstance(mapping, dict):
        raise ValueError('column_mapping must be an object.')
    parsed = team_budget_reporting.parse_xlsx(
        data,
        time_format=time_format,
        column_mapping=mapping,
        sheet_name=sheet_name,
    )
    return parsed, time_format


@app.route('/api/team-budgets/imports/preview', methods=['POST'])
def api_preview_new_team_budget_import():
    """Inspect a workbook before a team budget exists."""
    try:
        data, filename, sha256 = _read_team_workbook_upload()
        sheet_name = request.form.get('sheet') or None
        mapping = _team_form_json('column_mapping', None)
        inspection = team_budget_reporting.inspect_xlsx(data, sheet_name=sheet_name)
        if mapping is None and inspection['mapping_required']:
            return jsonify({
                **inspection,
                'filename': filename,
                'sha256': sha256,
                'replaces_rows': 0,
            })
        parsed, time_format = _parse_team_upload(data)
    except (ValueError, team_budget_reporting.XlsxImportError) as exc:
        return jsonify({'error': str(exc)}), 400

    dates = [row['date'] for row in parsed['rows'] if row['date'] <= date.today()]
    preview_start = min(dates) if dates else date.today()
    preview_end = max(dates) if dates else preview_start
    preview = team_budget_reporting.import_preview(
        parsed, preview_start, preview_end, set()
    )
    return jsonify({
        'mapping_required': False,
        'sheets': parsed['sheets'],
        'sheet': parsed['sheet'],
        'headers': parsed['headers'],
        'column_mapping': parsed['column_mapping'],
        'time_format': time_format,
        'filename': filename,
        'sha256': sha256,
        'replaces_rows': 0,
        **preview,
    })


@app.route('/api/team-budgets/from-import', methods=['POST'])
def api_create_team_budget_from_import():
    """Create a team budget and its first import as one atomic operation."""
    try:
        data, filename, sha256 = _read_team_workbook_upload()
        raw_budget = _team_form_json('budget', None)
        parsed, _time_format = _parse_team_upload(data)
    except (ValueError, team_budget_reporting.XlsxImportError) as exc:
        return jsonify({'error': str(exc)}), 400

    fields, members, error = _parse_team_budget_payload(raw_budget)
    if error:
        return jsonify({'error': error}), 400
    if fields['end_date'] < fields['start_date']:
        return jsonify({'error': 'The end date falls before the start date.'}), 400
    if parsed['errors']:
        first = parsed['errors'][0]
        return jsonify({
            'error': (
                f"Row {first['row']}: {first['error']} "
                f"({len(parsed['errors'])} invalid row(s))."
            ),
            'validation_errors': parsed['errors'][:50],
        }), 400
    historical_rows = [row for row in parsed['rows'] if row['date'] <= date.today()]
    if not historical_rows:
        return jsonify({'error': 'The workbook does not contain any historical rows to import.'}), 400

    member_fields = {
        member['source_user_id'].casefold(): member for member in members
    }
    missing_source_ids = sorted({
        row['source_user_id']
        for row in historical_rows
        if row['source_user_id'].casefold() not in member_fields
    }, key=str.casefold)
    if missing_source_ids:
        return jsonify({
            'error': (
                'Add every imported user before creating the budget: '
                + ', '.join(missing_source_ids)
            )
        }), 400

    workbook_dates = [row['date'] for row in historical_rows]
    fields['start_date'] = min(fields['start_date'], min(workbook_dates))
    fields['end_date'] = max(fields['end_date'], max(workbook_dates))
    team_budget = TeamBudget(
        **fields,
        imported_at=datetime.now(),
        import_filename=filename,
        import_sha256=sha256,
        import_row_count=len(historical_rows),
        import_skipped_count=len(parsed['rows']) - len(historical_rows),
    )
    source_map = {}
    for values in members:
        values = dict(values)
        values.pop('id', None)
        member = TeamBudgetMember(**values)
        team_budget.members.append(member)
        source_map[member.source_user_id.casefold()] = member

    try:
        db.session.add(team_budget)
        db.session.flush()
        db.session.add_all([
            TeamBudgetEntry(
                team_budget=team_budget,
                member=source_map[row['source_user_id'].casefold()],
                work_date=row['date'],
                time_seconds=row['seconds'],
                source_user_id=row['source_user_id'],
                source_row=row['row'],
            )
            for row in historical_rows
        ])
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise

    return jsonify(_team_budget_json(team_budget)), 201


@app.route('/api/team-budgets/<int:team_budget_id>/imports/preview', methods=['POST'])
def api_preview_team_budget_import(team_budget_id):
    team_budget = _team_budget_or_404(team_budget_id)
    if team_budget is None:
        return jsonify({'error': 'Team budget not found'}), 404
    try:
        data, filename, sha256 = _read_team_workbook_upload()
        sheet_name = request.form.get('sheet') or None
        mapping = _team_form_json('column_mapping', None)
        inspection = team_budget_reporting.inspect_xlsx(data, sheet_name=sheet_name)
        if mapping is None and inspection['mapping_required']:
            return jsonify({
                **inspection,
                'filename': filename,
                'sha256': sha256,
                'replaces_rows': team_budget.import_row_count,
            })
        parsed, time_format = _parse_team_upload(data)
    except (ValueError, team_budget_reporting.XlsxImportError) as exc:
        return jsonify({'error': str(exc)}), 400

    preview = team_budget_reporting.import_preview(
        parsed,
        team_budget.start_date,
        team_budget.end_date,
        _team_source_map(team_budget),
    )
    return jsonify({
        'mapping_required': False,
        'sheets': parsed['sheets'],
        'sheet': parsed['sheet'],
        'headers': parsed['headers'],
        'column_mapping': parsed['column_mapping'],
        'time_format': time_format,
        'filename': filename,
        'sha256': sha256,
        'replaces_rows': team_budget.import_row_count,
        **preview,
    })


def _validate_import_member_mappings(team_budget, unknown_ids, mappings):
    if not isinstance(mappings, dict):
        return None, 'user_mapping must be an object.'
    existing = {member.id: member for member in team_budget.members}
    plans = {}
    for source_id in unknown_ids:
        raw = mappings.get(source_id)
        if not isinstance(raw, dict):
            return None, f'Choose where imported user {source_id!r} belongs.'
        action = raw.get('action')
        if action == 'existing':
            try:
                member_id = int(raw.get('member_id'))
            except (TypeError, ValueError):
                return None, f'Choose a member for imported user {source_id!r}.'
            member = existing.get(member_id)
            if member is None:
                return None, f'The selected member for {source_id!r} no longer exists.'
            plans[source_id.casefold()] = {'action': 'existing', 'member': member}
        elif action == 'new':
            display_name = str(raw.get('display_name') or '').strip()
            if len(display_name) > 120:
                return None, f'The name for {source_id!r} is too long.'
            try:
                if isinstance(raw.get('budgeted_hours'), bool):
                    raise ValueError
                hours = float(raw.get('budgeted_hours'))
            except (TypeError, ValueError):
                return None, f'Enter budgeted hours for {source_id!r}.'
            if not math.isfinite(hours) or hours <= 0 or hours > 100000:
                return None, f'Enter valid budgeted hours for {source_id!r}.'
            plans[source_id.casefold()] = {
                'action': 'new',
                'display_name': display_name or None,
                'budgeted_hours': round(hours, 2),
                'source_user_id': source_id,
            }
        else:
            return None, f'Choose whether {source_id!r} is new or existing.'
    return plans, None


@app.route('/api/team-budgets/<int:team_budget_id>/imports', methods=['POST'])
def api_confirm_team_budget_import(team_budget_id):
    team_budget = _team_budget_or_404(team_budget_id)
    if team_budget is None:
        return jsonify({'error': 'Team budget not found'}), 404
    try:
        data, filename, sha256 = _read_team_workbook_upload()
        parsed, time_format = _parse_team_upload(data)
        mappings = _team_form_json('user_mapping', {})
    except (ValueError, team_budget_reporting.XlsxImportError) as exc:
        return jsonify({'error': str(exc)}), 400

    preview = team_budget_reporting.import_preview(
        parsed,
        team_budget.start_date,
        team_budget.end_date,
        _team_source_map(team_budget),
    )
    if preview['validation_error_count']:
        first = preview['validation_errors'][0]
        return jsonify({
            'error': (
                f"Row {first['row']}: {first['error']} "
                f"({preview['validation_error_count']} invalid row(s))."
            ),
            'validation_errors': preview['validation_errors'],
        }), 400
    if not preview['row_count']:
        return jsonify({'error': 'The workbook does not contain any historical rows to import.'}), 400

    plans, error = _validate_import_member_mappings(
        team_budget, preview['unknown_user_ids'], mappings
    )
    if error:
        return jsonify({'error': error}), 400

    range_action = request.form.get('out_of_range_action', 'skip')
    if range_action not in {'adjust', 'skip'}:
        return jsonify({'error': 'Choose to adjust the period or skip outside dates.'}), 400

    kept_rows = [row for row in parsed['rows'] if row['date'] <= date.today()]
    skipped_count = preview['future_row_count']
    if preview['out_of_range_row_count']:
        if range_action == 'adjust':
            dates = [row['date'] for row in kept_rows]
            team_budget.start_date = min(team_budget.start_date, min(dates))
            team_budget.end_date = max(team_budget.end_date, max(dates))
        else:
            original_count = len(kept_rows)
            kept_rows = [
                row for row in kept_rows
                if team_budget.start_date <= row['date'] <= team_budget.end_date
            ]
            skipped_count += original_count - len(kept_rows)
    if not kept_rows:
        db.session.rollback()
        return jsonify({'error': 'No rows remain inside the team budget period.'}), 400

    source_map = _team_source_map(team_budget)
    try:
        for source_key, plan in plans.items():
            if plan['action'] == 'existing':
                member = plan['member']
                alias = TeamBudgetMemberAlias(
                    team_budget_id=team_budget.id,
                    member=member,
                    source_user_id=next(
                        value for value in preview['unknown_user_ids']
                        if value.casefold() == source_key
                    ),
                )
                db.session.add(alias)
            else:
                member = TeamBudgetMember(
                    team_budget=team_budget,
                    source_user_id=plan['source_user_id'],
                    display_name=plan['display_name'],
                    budgeted_hours=plan['budgeted_hours'],
                )
                db.session.add(member)
            source_map[source_key] = member

        TeamBudgetEntry.query.filter_by(team_budget_id=team_budget.id).delete(
            synchronize_session=False
        )
        db.session.flush()
        db.session.add_all([
            TeamBudgetEntry(
                team_budget_id=team_budget.id,
                member_id=source_map[row['source_user_id'].casefold()].id,
                work_date=row['date'],
                time_seconds=row['seconds'],
                source_user_id=row['source_user_id'],
                source_row=row['row'],
            )
            for row in kept_rows
        ])
        team_budget.imported_at = datetime.now()
        team_budget.import_filename = filename
        team_budget.import_sha256 = sha256
        team_budget.import_row_count = len(kept_rows)
        team_budget.import_skipped_count = skipped_count
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise

    return jsonify({
        'success': True,
        'imported_rows': len(kept_rows),
        'skipped_rows': skipped_count,
        'time_format': time_format,
        'budget': _team_budget_json(team_budget, detail=True),
    })


@app.route('/api/team-budgets/<int:team_budget_id>/entries', methods=['GET'])
def api_team_budget_entries(team_budget_id):
    team_budget = _team_budget_or_404(team_budget_id)
    if team_budget is None:
        return jsonify({'error': 'Team budget not found'}), 404
    page = max(1, request.args.get('page', 1, type=int))
    per_page = min(200, max(10, request.args.get('per_page', 50, type=int)))
    member_id = request.args.get('member_id', type=int)

    query = TeamBudgetEntry.query.join(TeamBudgetMember).filter(
        TeamBudgetEntry.team_budget_id == team_budget.id
    )
    if member_id is not None:
        query = query.filter(TeamBudgetEntry.member_id == member_id)
    pagination = query.order_by(
        TeamBudgetEntry.work_date.desc(), TeamBudgetEntry.source_row.desc()
    ).paginate(page=page, per_page=per_page, error_out=False)
    return jsonify({
        'page': page,
        'pages': pagination.pages,
        'total': pagination.total,
        'entries': [
            {
                'id': entry.id,
                'date': entry.work_date.isoformat(),
                'member_id': entry.member_id,
                'member_name': entry.member.name,
                'source_user_id': entry.source_user_id,
                'seconds': entry.time_seconds,
                'hours': round(entry.time_seconds / 3600, 4),
            }
            for entry in pagination.items
        ],
    })


def _conflicting_task(date_obj, start, end, ignore_id=None):
    """The first task on ``date_obj`` that overlaps ``[start, end)``, or None.

    Returns ``(task, effective_end)`` — the second value because a running task
    has no end of its own but still occupies time, and the caller needs
    something to put in the error message.

    Intervals are half-open, so back-to-back tasks don't collide: one ending at
    11:00 and one starting at 11:00 share an instant and nothing else, and that
    is the single most common arrangement in the whole database.

    **A running task counts as occupying its start up to now.** It used to be
    skipped entirely for having no end time, which meant a task could be
    inserted straight through the middle of the one currently being tracked —
    the overlap only became visible later, when the running task was completed
    and suddenly collided with something already saved.
    """
    now = datetime.now()

    query = Task_Item.query.filter(Task_Item.date == date_obj)
    if ignore_id is not None:
        query = query.filter(Task_Item.id != ignore_id)

    for task in query.order_by(Task_Item.start_time).all():
        other_end = task.end_time
        if other_end is None:
            # Only today's task can still be running. An open row on an earlier
            # date is one the startup sweep hasn't reached yet (day_close.py);
            # it has no defensible extent, so it blocks nothing.
            if date_obj != now.date():
                continue
            other_end = now.time()
            if other_end <= task.start_time:
                continue

        if task.start_time < end and other_end > start:
            return task, other_end

    return None, None


def _conflict_response(task, effective_end):
    conflict_start = task.start_time.strftime('%H:%M')
    conflict_end = effective_end.strftime('%H:%M')
    return jsonify({
        # Keep the established `error` field for old clients while exposing
        # machine-readable canonical clock values to new ones.
        'error': f'Task times overlap with existing task ({conflict_start} - {conflict_end}). Please choose a different time.',
        'conflict': {
            'task_id': task.id,
            'start_time': conflict_start,
            'end_time': conflict_end,
        },
    }), 400


@app.route('/update_task/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    task = Task_Item.query.get_or_404(task_id)
    is_ongoing = task.end_time is None

    try:
        new_start = parse_clock_time(data['start_time'])
    except (KeyError, ValueError):
        return jsonify({'error': 'Invalid start time format'}), 400

    if is_ongoing:
        # History may move the start of the live task, but must not turn the
        # API's display-only effective end (the current time) into a real end.
        # Validate its occupied interval through now while keeping it open.
        conflict_end = datetime.now().time() if task.date == date.today() else new_start
        new_end = None
    else:
        try:
            new_end = parse_clock_time(data['end_time'])
        except (KeyError, ValueError):
            return jsonify({'error': 'Invalid end time format'}), 400
        conflict_end = new_end

    clash, clash_end = _conflicting_task(
        task.date,
        new_start,
        conflict_end,
        ignore_id=task_id,
    )
    if clash is not None:
        return _conflict_response(clash, clash_end)

    try:
        new_client_id = int(data['client_id'])
    except (TypeError, ValueError, KeyError):
        return jsonify({'error': 'A valid client is required'}), 400
    if Client.query.get(new_client_id) is None:
        return jsonify({'error': 'Client not found'}), 404

    # Validated before anything is assigned: a bad client id used to be rejected
    # *after* the times had already been written onto the task, so a failed
    # request still moved it as far as the next commit.
    task.start_time = new_start
    task.end_time = new_end
    task.client_id = new_client_id

    db.session.commit()
    return jsonify({'success': True})


# --------------------------------------------------------------------------
# Adding a task after the fact
#
# The Today page records time as it happens. This is the other way in: a block
# of work that was never tracked, entered against the day it belongs to from
# the History page. See day_bounds.py for the two rules that aren't obvious —
# which stretch of the day to suggest, and what happens when the task falls
# outside the day's recorded bounds.
# --------------------------------------------------------------------------


def _day_window(date_obj, day):
    """The span a day's gaps are measured inside, as ``(start, end)``.

    A finished day is bounded by its own recorded times. Today is bounded by
    now — the rest of the afternoon hasn't happened, and offering it as
    untracked time would suggest filling in work nobody has done yet. Anything
    else (no tracking row, no start) has no window, and therefore no
    suggestions.
    """
    if day is None or day.start_time is None:
        return None, None
    if day.end_time is not None:
        return day.start_time, day.end_time
    if date_obj == date.today():
        return day.start_time, datetime.now().time()
    return None, None


#: What the day strip spans when the day has no recorded bounds at all. 23:59
#: rather than midnight because every value on the strip has to be a legal
#: clock time — it is clicked to fill two time fields, and 24:00 is not a time.
#: The missing minute is a pixel wide and cannot be selected anyway.
_FALLBACK_WINDOW = (clock_time(0, 0), clock_time(23, 59))


def _day_busy_intervals(date_obj):
    """``(start, end)`` for every task on the day that occupies real time."""
    busy = []
    for task in Task_Item.query.filter_by(date=date_obj).all():
        end = task.end_time
        if end is None:
            # The running task occupies up to now; an unswept open row from an
            # earlier day occupies nothing (see _conflicting_task).
            if date_obj != date.today():
                continue
            end = datetime.now().time()
        if end > task.start_time:
            busy.append((task.start_time, end, task))
    return busy


@app.route('/api/day-timeline/<date_string>', methods=['GET'])
def api_day_timeline(date_string):
    """The shape of a day: what it spans, what's on it, and what isn't.

    Drives the Add task strip. Deliberately a separate read rather than
    something bolted onto `/tasks/<date>`: it's wanted when the form opens, not
    on every 60-second refresh of the page behind it.

    **The drawing window and the suggestion window are not the same.** The strip
    has to be drawn even for a day nobody pressed Start on, so it falls back to
    a whole day and stretches to contain any task that escapes the recorded
    bounds — nothing may be positioned off the end of the track. The *default*
    for the two time fields is only ever taken from gaps inside the day as
    actually recorded, because on a day with no bounds the fallback is one
    twenty-four-hour gap, and opening the form on 00:00–23:59 would be worse
    than opening it empty.
    """
    try:
        date_obj = datetime.strptime(date_string, '%Y-%m-%d').date()
    except ValueError:
        return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400

    day = TimeTracking.query.filter_by(date=date_obj).first()
    recorded_start, recorded_end = _day_window(date_obj, day)
    busy = _day_busy_intervals(date_obj)

    if recorded_start is not None and recorded_end is not None:
        window_start, window_end = recorded_start, recorded_end
        recommended = day_bounds.suggest_gaps(day_bounds.find_gaps(
            recorded_start, recorded_end, [(s, e) for s, e, _ in busy]
        ))
    else:
        window_start, window_end = _FALLBACK_WINDOW
        recommended = []

    for start, end, _task in busy:
        window_start = min(window_start, start)
        window_end = max(window_end, end)

    gaps = day_bounds.find_gaps(window_start, window_end, [(s, e) for s, e, _ in busy])

    return jsonify({
        'window': {
            'start_time': window_start.strftime('%H:%M'),
            'end_time': window_end.strftime('%H:%M'),
        },
        # The day as recorded, which is *not* the drawn window — it's what the
        # markers on the timeline point at, so a task dragged past the day's
        # close can be seen going past it before the confirmation says so.
        'day': None if day is None else {
            'start_time': None if day.start_time is None else day.start_time.strftime('%H:%M'),
            'end_time': None if day.end_time is None else day.end_time.strftime('%H:%M'),
        },
        'tasks': [
            {
                'id': task.id,
                'start_time': start.strftime('%H:%M'),
                'end_time': end.strftime('%H:%M'),
                'client': task_client_display_name(task),
                'client_id': task.client_id,
                'client_color': task_client_color(task),
                'ongoing': task.end_time is None,
            }
            for start, end, task in sorted(busy, key=lambda row: row[0])
        ],
        'gaps': [
            {'start_time': start.strftime('%H:%M'), 'end_time': end.strftime('%H:%M')}
            for start, end in gaps
        ],
        # The handful worth offering as buttons, longest first. Every gap is in
        # `gaps` above — this is the subset a person would actually pick from,
        # and nothing is filled in on the user's behalf from it.
        'recommended': [
            {'start_time': start.strftime('%H:%M'), 'end_time': end.strftime('%H:%M')}
            for start, end in recommended
        ],
    })


@app.route('/api/tasks', methods=['POST'])
def api_create_task():
    """Record a block of work that was never tracked live.

    Two-step when the task falls outside the day's recorded bounds: the first
    request comes back 409 describing what would move, and the client re-sends
    with ``stretch_day`` once the user has agreed. The alternative — refusing
    the task — has it backwards. The task is the record of what happened; the
    day's bounds are a note about when someone pressed two buttons.
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400

    try:
        date_obj = datetime.strptime(data.get('date', ''), '%Y-%m-%d').date()
    except (TypeError, ValueError):
        return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400
    if date_obj > date.today():
        return jsonify({'error': "That date hasn't happened yet"}), 400

    try:
        start = parse_clock_time(data.get('start_time'))
        end = parse_clock_time(data.get('end_time'))
    except ValueError:
        return jsonify({'error': 'Invalid start or end time format'}), 400
    if end <= start:
        # Not merely invalid — a zero-length task records nothing and would sit
        # in the timeline as an unclickable sliver.
        return jsonify({'error': 'End time must be after the start time'}), 400

    try:
        client_id = int(data.get('client_id'))
    except (TypeError, ValueError):
        return jsonify({'error': 'A valid client is required'}), 400
    client = Client.query.get(client_id)
    if client is None:
        return jsonify({'error': 'Client not found'}), 404

    clash, clash_end = _conflicting_task(date_obj, start, end)
    if clash is not None:
        return _conflict_response(clash, clash_end)

    day = TimeTracking.query.filter_by(date=date_obj).first()
    stretch = None

    if day is None:
        # A day nobody pressed Start on. The task is proof it was worked, so the
        # day is created around it rather than left absent — otherwise the entry
        # would show billable time on a day the Summary dashboard treats as
        # untouched. Today is created *open*: closing it here would leave the
        # Today page insisting the day had ended.
        day = TimeTracking(
            date=date_obj,
            start_time=start,
            end_time=None if date_obj == date.today() else end,
        )
        db.session.add(day)
    else:
        stretch = day_bounds.plan_stretch(day.start_time, day.end_time, start, end)
        if day_bounds.needs_stretch(stretch) and not data.get('stretch_day'):
            return jsonify({
                'error': _stretch_message(day, stretch),
                'needs_confirmation': True,
                'stretch': {
                    'start_time': None if stretch.start is None else stretch.start.strftime('%H:%M'),
                    'end_time': None if stretch.end is None else stretch.end.strftime('%H:%M'),
                },
            }), 409

    task = Task_Item(
        date=date_obj,
        start_time=start,
        end_time=end,
        client_id=client_id,
        type=None,
        description=None,
        time_spent=0,
    )
    db.session.add(task)

    if stretch is not None:
        if stretch.start is not None:
            day.start_time = stretch.start
        if stretch.end is not None:
            day.end_time = stretch.end

    db.session.commit()
    return jsonify({'success': True, 'task_id': task.id}), 201


def _stretch_message(day, stretch):
    """What the user is being asked to agree to, in the order they'd say it."""
    changes = []
    if stretch.start is not None:
        was = 'not set' if day.start_time is None else day.start_time.strftime('%H:%M')
        changes.append(f'start back to {stretch.start.strftime("%H:%M")} (was {was})')
    if stretch.end is not None:
        changes.append(
            f'end on to {stretch.end.strftime("%H:%M")} (was {day.end_time.strftime("%H:%M")})'
        )
    return 'This task falls outside the recorded day. Saving it will move the day ' + ' and '.join(changes) + '.'

def _work_json(work):
    return {
        'id': work.id,
        'date': work.date.strftime('%Y-%m-%d'),
        'client_id': work.client_id,
        'text': work.text,
    }


def _mark_activity_if_current_client(client_id):
    """Restart the reminder countdown if this client is the one being tracked.

    Any works CRUD counts as activity — writing, correcting and deleting are all
    evidence that the user is on top of their notes. It's scoped to the running
    task's client so that tidying up *yesterday's* Acme list in the task browser
    doesn't silence a nudge about the Globex task running right now.

    Note there is deliberately no suppression rule: having works already doesn't
    mute the reminder, exactly as a filled-in description never did. Only the
    countdown moves.
    """
    today = date.today()
    active = Task_Item.query.filter_by(date=today, end_time=None).first()
    if active and active.client_id == client_id:
        reminder_service.mark_activity()


@app.route('/api/works', methods=['GET'])
def get_works():
    """Works for one client on one day, oldest first.

    id is the tiebreaker rather than created_at alone because the backfill gives
    every migrated row the same synthetic midnight timestamp; insertion order is
    the real ordering and id preserves it.
    """
    date_str = request.args.get('date')
    client_id = request.args.get('client_id')

    if not date_str or not client_id:
        return jsonify({'error': 'date and client_id are required'}), 400

    try:
        date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()
        client_id = int(client_id)
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid date or client_id'}), 400

    works = (
        Work.query.filter_by(date=date_obj, client_id=client_id)
        .order_by(Work.created_at, Work.id)
        .all()
    )
    return jsonify([_work_json(w) for w in works])


@app.route('/api/works', methods=['POST'])
def create_work():
    data = request.get_json(silent=True) or {}
    work_text = (data.get('text') or '').strip()
    date_str = data.get('date')
    client_id = data.get('client_id')

    if not work_text:
        return jsonify({'error': 'Work text is required'}), 400

    try:
        date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()
        client_id = int(client_id)
    except (ValueError, TypeError):
        return jsonify({'error': 'A valid date and client are required'}), 400

    if Client.query.get(client_id) is None:
        return jsonify({'error': 'Client not found'}), 404

    if _find_duplicate_work(date_obj, client_id, work_text) is not None:
        return jsonify({'error': 'That work is already on the list'}), 409

    work = Work(date=date_obj, client_id=client_id, text=work_text)
    db.session.add(work)
    db.session.commit()
    _mark_activity_if_current_client(client_id)
    return jsonify(_work_json(work)), 201


@app.route('/api/works/<int:work_id>', methods=['PUT'])
def update_work(work_id):
    work = Work.query.get_or_404(work_id)
    data = request.get_json(silent=True) or {}
    work_text = (data.get('text') or '').strip()

    if not work_text:
        return jsonify({'error': 'Work text is required'}), 400

    duplicate = _find_duplicate_work(work.date, work.client_id, work_text)
    if duplicate is not None and duplicate.id != work.id:
        return jsonify({'error': 'That work is already on the list'}), 409

    work.text = work_text
    db.session.commit()
    _mark_activity_if_current_client(work.client_id)
    return jsonify(_work_json(work))


@app.route('/api/works/<int:work_id>', methods=['DELETE'])
def delete_work(work_id):
    work = Work.query.get_or_404(work_id)
    client_id = work.client_id
    db.session.delete(work)
    db.session.commit()
    _mark_activity_if_current_client(client_id)
    return jsonify({'success': True})


def _find_duplicate_work(date_obj, client_id, work_text):
    """Case-insensitive match within a client's day, or None.

    The table's unique constraint is exact-match only; catching "Triage" against
    an existing "triage" here is what stops the copied list reading as though
    the same thing was done twice.
    """
    return (
        Work.query.filter(
            Work.date == date_obj,
            Work.client_id == client_id,
            func.lower(Work.text) == work_text.lower(),
        ).first()
    )



@app.route('/task/<int:task_id>', methods=['DELETE'])
def delete_task(task_id):
    task = Task_Item.query.get_or_404(task_id)
    db.session.delete(task)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/update_day_time', methods=['POST'])
def update_day_time():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON object required'}), 400
    date_str = data.get('date')
    time_type = data.get('type')  # 'start' or 'end'
    time_str = data.get('time')
    
    if not date_str or not time_type or not time_str:
        return jsonify({'error': 'Missing required fields'}), 400
    
    try:
        date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()
        time_obj = parse_clock_time(time_str)
    except ValueError:
        return jsonify({'error': 'Invalid date or time format'}), 400
    
    # Find or create time tracking entry for the date
    time_tracking = TimeTracking.query.filter_by(date=date_obj).first()
    
    if not time_tracking:
        time_tracking = TimeTracking(date=date_obj)
        db.session.add(time_tracking)
    
    # Update the appropriate time field
    if time_type == 'start':
        time_tracking.start_time = time_obj
    elif time_type == 'end':
        time_tracking.end_time = time_obj
    else:
        return jsonify({'error': 'Invalid time type'}), 400
    
    db.session.commit()
    return jsonify({'success': True}), 200

# Define the global stop event
stop_event = threading.Event()
server_thread = None

def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]

# Global variable to store the port
app_port = find_free_port()


import logging
logging.basicConfig(level=logging.DEBUG, 
                    filename=os.path.join(user_data_dir, 'timekeeper.log'),
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('timekeeper')
def start_server():
    logger.debug(f"Starting server on port {app_port}")
    try:
        run_simple('127.0.0.1', app_port, app, use_reloader=False, threaded=True)
    except Exception as e:
        logger.error(f"Error starting server: {str(e)}")

def create_window():
    logger.debug(f"Creating window with URL: http://127.0.0.1:{app_port}")
    window_api = WebviewAPI()

    window = webview.create_window(
        'Time Keeper',
        f'http://127.0.0.1:{app_port}',
        js_api=window_api,
        width=1400,
        height=850,
        resizable=True,
        min_size=(800, 650),
        frameless=True,
        easy_drag=False,
        shadow=True,
        background_color=(
            '#0c0e12'
            if user_settings.get_setting('theme') == 'dark'
            else '#f6f7f9'
        ),
    )
    window.events.before_show += window_api._configure_native_window
    window.events.maximized += window_api._handle_maximized
    window.events.restored += window_api._handle_restored
    return window


def focus_window():
    """Bring the app window to the front — the "Open Time Keeper" toast button.

    Deliberately all Win32 through ctypes. The obvious version — pywebview's
    ``restore``/``show``, or a ``Control.Invoke`` — deadlocks when it runs on a
    request thread: those marshal a Python delegate onto the UI thread, and the
    UI thread needs the GIL this thread is holding while it waits. ctypes
    releases the GIL around each call, so the UI thread can run while this one
    waits for it.

    Only a minimised window is restored; a maximized one must keep its size.
    The topmost flick is a nudge past Windows' foreground lock, which otherwise
    just flashes the taskbar button; it's undone immediately so the app doesn't
    become permanently sticky.
    """
    if not webview.windows:
        return False

    window = webview.windows[0]
    if sys.platform != 'win32':
        try:
            window.restore()
            window.show()
            return True
        except Exception as exc:
            logger.warning(f'Could not focus the window: {exc}')
            return False

    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.IsIconic.argtypes = (wintypes.HWND,)
        user32.IsIconic.restype = wintypes.BOOL
        user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
        user32.ShowWindow.restype = wintypes.BOOL
        user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
        user32.SetForegroundWindow.restype = wintypes.BOOL
        user32.SetWindowPos.argtypes = (
            wintypes.HWND,
            wintypes.HWND,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.UINT,
        )
        user32.SetWindowPos.restype = wintypes.BOOL

        hwnd = wintypes.HWND(window.native.Handle.ToInt64())
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        else:
            user32.ShowWindow(hwnd, 5)  # SW_SHOW

        user32.SetForegroundWindow(hwnd)

        # Raise past every other window, then drop the sticky flag again.
        swp_flags = 0x0002 | 0x0001  # SWP_NOMOVE | SWP_NOSIZE
        user32.SetWindowPos(hwnd, wintypes.HWND(-1), 0, 0, 0, 0, swp_flags)  # TOPMOST
        user32.SetWindowPos(hwnd, wintypes.HWND(-2), 0, 0, 0, 0, swp_flags)  # NOTOPMOST
        return True
    except Exception as exc:
        logger.warning(f'Could not focus the window: {exc}')
        return False


@app.route('/api/window/focus', methods=['POST'])
def api_window_focus():
    """Raise the app window — the second-launch handoff.

    A second copy of the program asks the running one to come forward and then
    exits. The response body matters less than the status: any 200 tells the
    caller that this process owns the app, so it should stay out of the way.
    """
    return jsonify({'focused': focus_window()})


def start_reminders():
    """Get the description reminder ready. Never fatal — it's a convenience.

    Both the icon copy and the protocol registration have to happen before the
    first toast: the icon because a toast lingering in the Action Center needs a
    path that outlives the process, the registration because a button whose URI
    nothing handles silently does nothing when clicked.
    """
    try:
        source_dir = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
        notifications.install_icon(source_dir, user_data_dir)
        notifications.ensure_protocol_registered()

        reason = notifications.unavailable_reason()
        if reason:
            logger.warning(f'Description reminders are disabled: {reason}')

        reminder_service.start()
    except Exception as exc:
        logger.error(f'Could not start the reminder service: {exc}')


def start_webview():
    """Hand control to pywebview.

    `debug=True` is what enables the WebView2 context menu and its "Inspect"
    entry (plus F12), so devtools are available whenever we're running from
    source. It also stops WebView2 caching static assets, which otherwise
    makes CSS/JS edits look like they did nothing until a hard reload.
    """
    if DEVTOOLS:
        print('Devtools enabled — right-click anywhere or press F12 to inspect.')

    webview.start(debug=DEVTOOLS)



class WebviewAPI:
    def __init__(self):
        self._maximized = False
        # Python.NET event delegates must be kept alive for as long as the form.
        self._native_move_handler = None
        self._webview_ready_handler = None
        # Same deal for the ctypes callback subclassing the form's window
        # procedure: the OS keeps only the raw function pointer.
        self._native_subclass_proc = None

    def _configure_native_window(self):
        """Give the frameless WinForms window normal Windows chrome behavior.

        WebView2 supports HTML regions that participate in native non-client
        hit testing. Enabling that support makes CSS ``app-region: drag`` act
        like a real caption, including Aero Snap, double-click maximize, and
        the system menu. WinForms still needs an explicit maximized work area
        because its borderless form otherwise covers the taskbar.
        """
        if sys.platform != 'win32' or not webview.windows:
            return

        try:
            import System.Drawing as Drawing
            import System.Windows.Forms as WinForms

            native = webview.windows[0].native
            # Before the styles go on, so the frame the sizing style reserves
            # is suppressed in the same breath as it is added.
            self._suppress_non_client_frame(native)
            self._enable_native_snap(native)

            def enable_non_client_regions(sender, args):
                if args.IsSuccess:
                    sender.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = True

            self._webview_ready_handler = enable_non_client_regions
            if native.webview.CoreWebView2:
                native.webview.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = True
            else:
                native.webview.CoreWebView2InitializationCompleted += self._webview_ready_handler

            def update_maximized_bounds(*_args):
                if native.WindowState == WinForms.FormWindowState.Normal:
                    self._set_maximized_bounds(native, WinForms, Drawing)

            self._native_move_handler = update_maximized_bounds
            native.Move += self._native_move_handler
            update_maximized_bounds()
        except Exception as exc:
            # The app remains usable with pywebview's basic frameless behavior
            # if a future backend no longer exposes these WebView2 APIs.
            logger.warning(f'Could not configure native Windows chrome: {exc}')

    def _suppress_non_client_frame(self, native):
        """Stop the sizing frame from reserving visible pixels around the window.

        ``_enable_native_snap`` restores ``WS_THICKFRAME`` so Windows will
        commit an Aero Snap, but a window with a sizing frame also reserves a
        strip of non-client pixels on every edge. WinForms paints no frame of
        its own for a borderless form, so that strip shows the form background
        — a bar above the HTML title bar that is most obvious in dark mode.

        The frame is removed the way any custom-chrome window does it: by
        answering ``WM_NCCALCSIZE`` with "the whole window is client area".
        The style bits are left alone, so Windows still treats the window as
        resizable and snappable; only the drawn frame goes away. WinForms'
        ``WndProc`` cannot be overridden from Python.NET (its ``ref Message``
        parameter is unsupported), hence subclassing through ``comctl32``.
        """
        import ctypes
        from ctypes import wintypes

        wm_nccalcsize = 0x0083

        comctl32 = ctypes.WinDLL('comctl32', use_last_error=True)

        subclass_proc = ctypes.WINFUNCTYPE(
            wintypes.LPARAM,
            wintypes.HWND,
            ctypes.c_uint,
            wintypes.WPARAM,
            wintypes.LPARAM,
            ctypes.c_size_t,
            ctypes.c_size_t,
        )
        comctl32.SetWindowSubclass.argtypes = (
            wintypes.HWND,
            subclass_proc,
            ctypes.c_size_t,
            ctypes.c_size_t,
        )
        comctl32.SetWindowSubclass.restype = wintypes.BOOL
        comctl32.DefSubclassProc.argtypes = (
            wintypes.HWND,
            ctypes.c_uint,
            wintypes.WPARAM,
            wintypes.LPARAM,
        )
        comctl32.DefSubclassProc.restype = wintypes.LPARAM

        def handle_message(hwnd, message, wparam, lparam, _subclass_id, _ref_data):
            # wparam TRUE means "recalculate the client area"; returning zero
            # without filling in NCCALCSIZE_PARAMS makes client == window.
            if message == wm_nccalcsize and wparam:
                return 0
            return comctl32.DefSubclassProc(hwnd, message, wparam, lparam)

        self._native_subclass_proc = subclass_proc(handle_message)
        hwnd = wintypes.HWND(native.Handle.ToInt64())
        ctypes.set_last_error(0)
        if not comctl32.SetWindowSubclass(hwnd, self._native_subclass_proc, 1, 0):
            raise ctypes.WinError(ctypes.get_last_error())

    @staticmethod
    def _enable_native_snap(native):
        """Restore the Win32 styles Aero Snap requires on a frameless form.

        WinForms removes its sizing frame when ``FormBorderStyle`` becomes
        ``None``. WebView2 can still initiate a native caption drag through an
        ``app-region``, but Windows will only preview the maximize target; it
        will not commit the snap unless the host advertises a sizing frame and
        maximize support. These flags describe capability only—the visible
        chrome remains the HTML title bar.
        """
        import ctypes
        from ctypes import wintypes

        gwl_style = -16
        ws_maximizebox = 0x00010000
        ws_minimizebox = 0x00020000
        ws_thickframe = 0x00040000
        ws_sysmenu = 0x00080000
        swp_nomove = 0x0002
        swp_nosize = 0x0001
        swp_nozorder = 0x0004
        swp_noactivate = 0x0010
        swp_framechanged = 0x0020

        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.GetWindowLongW.argtypes = (wintypes.HWND, ctypes.c_int)
        user32.GetWindowLongW.restype = ctypes.c_long
        user32.SetWindowLongW.argtypes = (
            wintypes.HWND,
            ctypes.c_int,
            ctypes.c_long,
        )
        user32.SetWindowLongW.restype = ctypes.c_long
        user32.SetWindowPos.argtypes = (
            wintypes.HWND,
            wintypes.HWND,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.UINT,
        )
        user32.SetWindowPos.restype = wintypes.BOOL

        hwnd = wintypes.HWND(native.Handle.ToInt64())
        style = user32.GetWindowLongW(hwnd, gwl_style)
        snap_style = (
            style
            | ws_thickframe
            | ws_maximizebox
            | ws_minimizebox
            | ws_sysmenu
        )
        if snap_style == style:
            return

        ctypes.set_last_error(0)
        previous = user32.SetWindowLongW(hwnd, gwl_style, snap_style)
        if previous == 0 and ctypes.get_last_error():
            raise ctypes.WinError(ctypes.get_last_error())

        frame_flags = (
            swp_nomove
            | swp_nosize
            | swp_nozorder
            | swp_noactivate
            | swp_framechanged
        )
        if not user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, frame_flags):
            raise ctypes.WinError(ctypes.get_last_error())

    def navigate(self, url):
        webview.windows[0].evaluate_js(f'window.location.href = "{url}"')

    def minimize(self):
        webview.windows[0].minimize()

    def toggle_maximize(self):
        window = webview.windows[0]
        maximized = not self._maximized
        if maximized:
            self._refresh_maximized_bounds()
            window.maximize()
        else:
            window.restore()

        self._sync_maximized(maximized)
        return maximized

    def _refresh_maximized_bounds(self):
        if sys.platform != 'win32' or not webview.windows:
            return

        try:
            import System.Drawing as Drawing
            import System.Windows.Forms as WinForms
            from System import Action

            native = webview.windows[0].native
            native.Invoke(
                Action(
                    lambda: self._set_maximized_bounds(native, WinForms, Drawing)
                )
            )
        except Exception as exc:
            logger.warning(f'Could not refresh maximized window bounds: {exc}')

    @staticmethod
    def _set_maximized_bounds(native, winforms, drawing):
        """Constrain a borderless maximized form to its monitor's work area.

        WinForms treats ``MaximizedBounds.X/Y`` as offsets from the current
        monitor, rather than virtual-desktop coordinates. Supplying
        ``WorkingArea`` directly therefore applies a negative monitor position
        twice and can move the window entirely off-screen. There is no sizing
        frame to account for: the client area covers the whole window (see
        ``_suppress_non_client_frame``), so the work area is the whole answer.
        """
        screen = winforms.Screen.FromHandle(native.Handle)
        work_area = screen.WorkingArea
        screen_bounds = screen.Bounds
        native.MaximizedBounds = drawing.Rectangle(
            work_area.X - screen_bounds.X,
            work_area.Y - screen_bounds.Y,
            work_area.Width,
            work_area.Height,
        )

    def resize_window(self, width, height, direction):
        """Resize from a custom frame edge while anchoring its opposite side."""
        direction = str(direction).lower()
        if direction not in {'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'}:
            raise ValueError('Unknown resize direction')

        width = max(800, int(round(width)))
        height = max(650, int(round(height)))
        horizontal_anchor = FixPoint.EAST if 'w' in direction else FixPoint.WEST
        vertical_anchor = FixPoint.SOUTH if 'n' in direction else FixPoint.NORTH
        webview.windows[0].resize(
            width,
            height,
            horizontal_anchor | vertical_anchor,
        )

    def _sync_maximized(self, maximized):
        self._maximized = maximized
        if not webview.windows:
            return

        javascript_value = 'true' if maximized else 'false'
        webview.windows[0].evaluate_js(
            f'window.timeKeeperWindowChrome?.setMaximized({javascript_value})'
        )

    def _handle_maximized(self):
        self._sync_maximized(True)

    def _handle_restored(self):
        self._sync_maximized(False)

    def close(self):
        webview.windows[0].destroy()


def _format_admin_clock(_view, _context, model, column_name):
    """Render a stored clock in Flask-Admin using the display preference.

    This is presentation-only: model values remain ``datetime.time`` objects,
    and API responses continue to use canonical 24-hour strings. Flask-Admin's
    browser/native form widgets can still follow browser locale conventions;
    these formatters cover the generated list and detail text.
    """
    value = getattr(model, column_name, None)
    if value is None:
        return ''
    if user_settings.get_setting('time_format') == '24h':
        return value.strftime('%H:%M')
    return value.strftime('%I:%M %p').lstrip('0')


class TaskItemAdminView(ModelView):
    column_formatters = {
        'start_time': _format_admin_clock,
        'end_time': _format_admin_clock,
    }
    column_formatters_detail = column_formatters


class TimeTrackingAdminView(ModelView):
    column_formatters = {
        'start_time': _format_admin_clock,
        'end_time': _format_admin_clock,
        # Legacy field, but it is still a db.Time column exposed by this view.
        'pause_time': _format_admin_clock,
    }
    column_formatters_detail = column_formatters


class BreakTrackingAdminView(ModelView):
    column_formatters = {
        'start_time': _format_admin_clock,
        'end_time': _format_admin_clock,
    }
    column_formatters_detail = column_formatters


admin = Admin(app, name='Admin Panel', theme=Bootstrap4Theme())

# Add model views to Flask-Admin
admin.add_view(TaskItemAdminView(Task_Item, db.session))
admin.add_view(TimeTrackingAdminView(TimeTracking, db.session))
admin.add_view(ModelView(Client, db.session))
admin.add_view(BreakTrackingAdminView(BreakTracking, db.session))
admin.add_view(ModelView(Work, db.session))
admin.add_view(ModelView(Budget, db.session))

if __name__ == '__main__':
    # Publish the port before the server is up: a toast button click can only
    # arrive once we're listening, and the file is what tells that second
    # process where to knock.
    ipc.publish_port(app_port)
    atexit.register(ipc.clear_port)

    # Start Flask server in a separate thread
    t = threading.Thread(target=start_server)
    t.daemon = True
    t.start()

    start_reminders()
    start_startup_update_check()

    # Create and start webview window
    window = create_window()

    start_webview()
