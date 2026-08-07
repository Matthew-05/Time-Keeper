import sys
import os
from pathlib import Path
import httpx
import getpass

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

    sys.exit(0 if ipc.forward_uri(_toast_uri) else 1)

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
from models import db, Client, Task_Item, TimeTracking, BreakTracking, Work
import settings as user_settings
import notifications
import ipc
from reminders import ReminderService
import atexit
import threading
import time
import math
from datetime import datetime, date, timedelta
from sqlalchemy import text, inspect, desc, and_
from flask_migrate import Migrate
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView
from flask_admin.theme import Bootstrap4Theme
import webview
from werkzeug.serving import run_simple
from werkzeug.middleware.dispatcher import DispatcherMiddleware
from sqlalchemy import func, String, literal
import socket


class UsageLogger:
    """Handles logging of automation usage to external API."""

    @staticmethod
    def send_log(action_name, details=None):
        """Send usage log to external API.

        Args:
            action_name: Name of the action/automation being logged
            details: Optional dictionary of additional details to log
        """
        try:
            url = 'https://matthewcodes.xyz/api/project-usage/'

            headers = {
                'Authorization': 'J9EuaQDk85QQIRbsKmQ-RfjKKzlT8U7NnBj-eJTr30c',
                'Content-Type': 'application/json',
            }

            data = {
                'application_name': 'Time-Keeper',
                'action': action_name,
                'username': getpass.getuser(),
            }

            # Add details if provided
            if details:
                data.update(details)

            with httpx.Client() as client:
                response = client.post(
                    url,
                    json=data,
                    headers=headers,
                    follow_redirects=True
                )
                print(f"Request method: {response.request.method}")
                print(f"Response status: {response.status_code}")
                print(f"Response content: {response.text}")

                return response.json() if response.status_code in (200, 201) else response.text
        except Exception as e:
            print(f"Error sending log: {str(e)}")
            return None


APP_VERSION = "1.2.0"


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
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

if DEV_MODE:
    # Don't let the webview sit on a stale app.css / base.js between edits.
    app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
    app.config['TEMPLATES_AUTO_RELOAD'] = True

# Tell SQLAlchemy to use the user directory for instance data
app.instance_path = user_data_dir

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

    try:
        saved = user_settings.update_settings(changes)
    except OSError as exc:
        logger.error(f'Could not save settings: {exc}')
        return jsonify({'error': 'Could not write the settings file'}), 500

    return jsonify(saved)


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
    if _work_table_is_new:
        _backfill_works_from_descriptions()


#: Sorts above every real timestamp, so an in-progress task ranks as "right now".
_IN_PROGRESS_SORT_KEY = "9999-12-31 23:59:59.999999"


def _task_end_sort_string():
    """Lexicographically sortable 'YYYY-MM-DD HH:MM:SS.ffffff' end moment per task.

    SQLAlchemy stores SQLite Date/Time as zero-padded ISO text, so plain string
    comparison is chronological. A task that has not been completed yet has no
    end time; it counts as the most recent activity, so it gets a sentinel key
    that sorts above every real timestamp.
    """
    return func.coalesce(
        Task_Item.date.cast(String) + literal(" ") + Task_Item.end_time.cast(String),
        literal(_IN_PROGRESS_SORT_KEY),
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
    return jsonify([{'id': client.id, 'name': client.name} for client in clients])

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
    data = request.get_json()
    name = data.get('name')
    if name:
        if not Client.query.filter_by(name=name).first():
            new_client = Client(name=name)
            db.session.add(new_client)
            db.session.commit()
            return jsonify({'id': new_client.id, 'name': new_client.name}), 201
        return jsonify({'error': 'Client already exists'}), 400
    return jsonify({'error': 'Name field is required'}), 400

@app.route('/clients/<int:id>', methods=['GET'])
def get_client(id):
    client = Client.query.get(id)
    return jsonify({'id': client.id, 'name': client.name})

@app.route('/clients/<int:id>', methods=['PUT'])
def update_client(id):
    client = Client.query.get(id)
    client.name = request.json['name']
    db.session.commit()
    return jsonify({'success': True})

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

@app.route('/tasks/<date>')
def get_tasks(date):
    date_obj = datetime.strptime(date, '%Y-%m-%d').date()
    tasks = Task_Item.query.filter_by(date=date_obj).all()
    current_time = datetime.now().time()
    
    tasks_data = [{
        'id': task.id,
        'date': task.date.strftime('%Y-%m-%d'),
        'start_time': task.start_time.strftime('%H:%M:%S'),
        'end_time': current_time.strftime('%H:%M:%S') if task.end_time is None else task.end_time.strftime('%H:%M:%S'),
        'client_id': task.client_id,
        'client_name': task_client_display_name(task),
        'type': task.type,
        'description': task.description,
        'time_spent': task.time_spent,
        'adjust_entry': task.adjust_entry,
        'is_ongoing': task.end_time is None
    } for task in tasks]
    return jsonify(tasks_data)

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
            'mostRecentTaskEndTime': most_recent_task.end_time.strftime('%I:%M %p')
        })
    else:
        # If no completed tasks today, return the day's start time
        day_start = TimeTracking.query.filter_by(date=today).first()
        if day_start and day_start.start_time:
            return jsonify({
                'mostRecentTaskEndTime': day_start.start_time.strftime('%I:%M %p')
            })
    
    # If no day start or completed tasks, return null
    return jsonify({
        'mostRecentTaskEndTime': None
    })

@app.route('/complete_task', methods=['POST'])
def complete_task():
    print("Completing task")
    data = request.json
    client_name = data.get('client')
    end_time = data.get('endTime')
    type = data.get('type')
    print("submitted end time", end_time)
    datetime_obj = datetime.strptime(end_time, '%I:%M %p').time()
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
    data = request.json
    client_name = data.get('client')
    now = datetime.now()
    start_date = now.date()
    start_time = data.get('startTime')
    print("submitted start time", start_time)
    datetime_obj = datetime.strptime(start_time, '%I:%M %p').time()


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
    data = request.json
    submitted_time = data.get('time')
    datetime_obj = datetime.strptime(submitted_time, '%I:%M %p').time()
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
    existing_entry = TimeTracking.query.filter_by(date=today).first()
    if not existing_entry:
        return jsonify({'error': 'Day has not been started yet'}), 400

    existing_entry.end_time = datetime.now().time()
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
    
@app.route('/start_break', methods=['POST'])
def start_break():
    today = datetime.now().date()
    data = request.json
    submitted_time = data.get('time')
    datetime_obj = datetime.strptime(submitted_time, '%I:%M %p').time()
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
    data = request.json
    submitted_time = data.get('time')
    print(submitted_time)
    datetime_obj = datetime.strptime(submitted_time, '%I:%M %p').time()
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

        
    min_time = '12:00 AM'
    return jsonify({'min_time': min_time})

@app.route('/summary')
def summary_page():
    clients = Client.query.all()
    return render_template('time_summary.html', clients=clients, version=APP_VERSION)
    
def _parse_range(start_date, end_date):
    """Parse two YYYY-MM-DD strings, tolerating them being the wrong way round.

    Returns (start, end) or raises ValueError.
    """
    start = datetime.strptime(start_date, '%Y-%m-%d').date()
    end = datetime.strptime(end_date, '%Y-%m-%d').date()
    return (end, start) if start > end else (start, end)


def task_duration_seconds(task, now=None):
    """How long a task ran, in seconds.

    Task_Item.time_spent is never populated (it's written as 0 on creation and
    never updated), so duration always has to be derived from the timestamps.

    An unfinished task on today's date is measured up to the current time; on
    any earlier date there's no sensible end, so it counts as zero rather than
    silently inventing time.
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


def tasks_between(start, end):
    return Task_Item.query.filter(
        Task_Item.date >= start,
        Task_Item.date <= end,
    ).all()


def round_to_quarter_hour(seconds):
    """Seconds -> hours rounded to the nearest quarter.

    Mirrors `totalTimeSpentToFractionalHours` in task_browser.js. Uses explicit
    half-up rounding rather than Python's round(), which is banker's rounding
    and would disagree with the JS on exact .125 boundaries (7.5 min).
    """
    quarters = seconds / 900.0
    return math.floor(quarters + 0.5) / 4.0


def bucket_by_client_and_day(start, end, now=None):
    """Tracked seconds keyed by (client name, date).

    Rounding has to happen at this granularity — one client, one day — because
    that's the unit the History page rounds at, and it's what actually gets
    billed. Rounding a whole week in one go would give a different (smaller)
    number than the sum of the days it's made of.
    """
    now = now or datetime.now()

    buckets = {}
    for task in tasks_between(start, end):
        key = (task_client_display_name(task), task.date)
        buckets[key] = buckets.get(key, 0) + task_duration_seconds(task, now)
    return buckets


@app.route('/api/summary/custom/<start_date>/<end_date>', methods=['GET'])
def get_custom_summary(start_date, end_date):
    """Billable hours per client across a date range.

    `total_hours` is the billable figure: each client-day rounded up or down to
    the nearest quarter hour, then summed. `tracked_hours` is the raw
    unrounded time, so the UI can show what the rounding did.
    """
    try:
        start, end = _parse_range(start_date, end_date)
    except ValueError:
        return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400

    rounded = {}
    tracked = {}
    for (name, _day), seconds in bucket_by_client_and_day(start, end).items():
        rounded[name] = rounded.get(name, 0) + round_to_quarter_hour(seconds)
        tracked[name] = tracked.get(name, 0) + seconds

    return jsonify([
        {
            'client_name': name,
            'total_hours': round(hours, 2),
            'tracked_hours': round(tracked[name] / 3600, 2),
        }
        for name, hours in sorted(rounded.items(), key=lambda kv: -kv[1])
    ])


@app.route('/api/summary/daily/<start_date>/<end_date>', methods=['GET'])
def get_daily_summary(start_date, end_date):
    """Billable hours per day across a date range.

    Same rounding rule as the per-client view: each client's time within a day
    is rounded to the nearest quarter hour, then the day is the sum of those.

    Ordered by date, and only days that actually have tasks are included so
    days off don't drag the moving average down.
    """
    try:
        start, end = _parse_range(start_date, end_date)
    except ValueError:
        return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400

    rounded = {}
    tracked = {}
    for (_name, day), seconds in bucket_by_client_and_day(start, end).items():
        rounded[day] = rounded.get(day, 0) + round_to_quarter_hour(seconds)
        tracked[day] = tracked.get(day, 0) + seconds

    return jsonify([
        {
            'date': day.strftime('%Y-%m-%d'),
            'total_hours': round(hours, 2),
            'tracked_hours': round(tracked[day] / 3600, 2),
        }
        for day, hours in sorted(rounded.items())
    ])


@app.route('/api/summary/<string:period>/<int:client_id>', methods=['GET'])
def get_time_summary(period, client_id):
    if period not in ['weekly', 'monthly']:
        return jsonify({'error': 'Invalid period. Use "weekly" or "monthly".'}), 400

    today = datetime.now().date()
    if period == 'weekly':
        start_date = today - timedelta(days=today.weekday())
    else:  # monthly
        start_date = today.replace(day=1)

    now = datetime.now()
    total_time = sum(
        task_duration_seconds(task, now)
        for task in Task_Item.query.filter(
            Task_Item.client_id == client_id,
            Task_Item.date >= start_date,
        ).all()
    )

    return jsonify({
        'client_id': client_id,
        'period': period,
        'total_time': total_time
    })

@app.route('/update_task/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    data = request.json
    task = Task_Item.query.get_or_404(task_id)
    
    new_start = datetime.strptime(data['start_time'], '%I:%M %p').time()
    new_end = datetime.strptime(data['end_time'], '%I:%M %p').time()
    
    print(f"Looking for tasks around - Start: {new_start}, End: {new_end}")
    
    # Get all tasks for the day sorted by start time
    all_tasks = Task_Item.query.filter(
        Task_Item.date == task.date,
        Task_Item.id != task_id,
        Task_Item.end_time.isnot(None)
    ).order_by(Task_Item.start_time).all()
    
    print("All tasks for the day:", [(t.id, t.start_time, t.end_time) for t in all_tasks])
    
    # Find surrounding tasks
    prev_task = None
    next_task = None
    
    for t in all_tasks:
        if t.end_time <= new_start:
            prev_task = t
        if t.start_time >= new_end and next_task is None:
            next_task = t
            break
    
    # Check for overlaps
    overlapping = any(
        t.start_time < new_end and t.end_time > new_start 
        for t in all_tasks
    )

    if overlapping:
        overlapping_task = next(t for t in all_tasks if t.start_time < new_end and t.end_time > new_start)
        return jsonify({
            'error': f'Task times overlap with existing task ({overlapping_task.start_time.strftime("%I:%M %p")} - {overlapping_task.end_time.strftime("%I:%M %p")}). Please choose a different time.'
        }), 400

    task.start_time = new_start
    task.end_time = new_end
    try:
        new_client_id = int(data['client_id'])
    except (TypeError, ValueError, KeyError):
        return jsonify({'error': 'A valid client is required'}), 400
    if Client.query.get(new_client_id) is None:
        return jsonify({'error': 'Client not found'}), 404
    task.client_id = new_client_id

    db.session.commit()
    return jsonify({'success': True})

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
    data = request.json
    date_str = data.get('date')
    time_type = data.get('type')  # 'start' or 'end'
    time_str = data.get('time')
    
    if not date_str or not time_type or not time_str:
        return jsonify({'error': 'Missing required fields'}), 400
    
    try:
        date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()
        time_obj = datetime.strptime(time_str, '%I:%M %p').time()
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
    
    window = webview.create_window(
        'Time Tracker',
        f'http://127.0.0.1:{app_port}',
        width=1200,
        height=800,
        resizable=True,
        min_size=(800, 650)
    )
    return window


def focus_window():
    """Bring the app window to the front — the "Open Time Keeper" toast button.

    Restoring is the important half: the usual reason someone clicks this is
    that the window is minimised behind whatever they were actually doing. The
    on_top flick is a nudge past Windows' foreground-lock, which otherwise
    flashes the taskbar button instead of raising the window; it's set back
    immediately so the app doesn't become permanently sticky.
    """
    if not webview.windows:
        return False

    window = webview.windows[0]
    try:
        window.restore()
        window.show()
        try:
            window.on_top = True
            window.on_top = False
        except Exception:
            # Not supported on every pywebview backend; the restore still ran.
            pass
        return True
    except Exception as exc:
        logger.warning(f'Could not focus the window: {exc}')
        return False


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
    def navigate(self, url):
        webview.windows[0].evaluate_js(f'window.location.href = "{url}"')


admin = Admin(app, name='Admin Panel', theme=Bootstrap4Theme())

# Add model views to Flask-Admin
admin.add_view(ModelView(Task_Item, db.session))
admin.add_view(ModelView(TimeTracking, db.session))
admin.add_view(ModelView(Client, db.session))
admin.add_view(ModelView(BreakTracking, db.session))
admin.add_view(ModelView(Work, db.session))

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

    # Create and start webview window
    window = create_window()

    start_webview()
