"""User settings, persisted as JSON alongside the database.

The SQLite database holds *work* data — clients, tasks, days. Preferences are a
different kind of thing: there's exactly one of each, they're read on every page
render, and they should survive a database reset. So they live in their own file
next to it, at ``%LOCALAPPDATA%\\TimeKeeper\\settings.json``.

Design notes:

- **Every read is defensive.** A missing file, a truncated file, a hand-edited
  file with a bad value — none of those should stop the app from starting. Any
  key that fails validation silently falls back to its default, and a file that
  won't parse at all is treated as empty.
- **Writes are atomic.** Write to a temp file in the same directory, then
  ``os.replace``. A crash mid-save leaves the previous settings intact rather
  than a half-written file that won't parse.
- **Unknown keys are dropped on write.** Whatever the file happens to contain,
  what we save back is exactly the current schema, so the file stays readable.

To add a setting: add an entry to ``_SCHEMA``. Nothing else here needs touching.
"""

import json
import os
import tempfile
import threading
from datetime import date
from pathlib import Path

# Same directory the database lives in — see main.py.
USER_DATA_DIR = os.path.join(Path.home(), 'AppData', 'Local', 'TimeKeeper')
SETTINGS_PATH = os.path.join(USER_DATA_DIR, 'settings.json')

THEME_CHOICES = ('light', 'dark', 'auto')
TIME_FORMAT_CHOICES = ('12h', '24h')
ROUNDING_DIRECTION_CHOICES = ('nearest', 'up', 'down')
ROUNDING_INTERVAL_MIN = 1
ROUNDING_INTERVAL_MAX = 60

# Bounds for the description reminder. The UI enforces these too, but a
# hand-edited file or a stale client shouldn't be able to set a 0-minute
# interval and turn the reminder into a firehose.
REMINDER_INTERVAL_MIN = 1
REMINDER_INTERVAL_MAX = 480  # 8 hours — longer than a working day.
REMINDER_SNOOZE_MIN = 1
REMINDER_SNOOZE_MAX = 120

# Default hours contributed by each recurring workday. Date-specific rules can
# replace this amount for individual dates or filtered ranges.
WORK_HOURS_PER_DAY_MIN = 0.25
WORK_HOURS_PER_DAY_MAX = 24
DEFAULT_WORK_DAYS = [0, 1, 2, 3, 4]  # Monday through Friday.


def _validate_choice(choices):
    """Build a validator accepting only one of `choices` (case-insensitively)."""

    def validate(value):
        if isinstance(value, str) and value.lower() in choices:
            return value.lower()
        return None  # Rejected — caller substitutes the default.

    return validate


def _validate_bool(value):
    """Accept only a real boolean — not 'true', not 1."""
    return value if isinstance(value, bool) else None


def _validate_int(low, high):
    """Build a validator for a whole number within an inclusive range."""

    def validate(value):
        # `bool` is a subclass of `int`, and True is not a sensible interval.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        # JSON has one number type, so 30.0 arrives as a float. That's a fine
        # integer; 30.5 is not.
        if isinstance(value, float) and not value.is_integer():
            return None
        value = int(value)
        return value if low <= value <= high else None

    return validate


def _validate_number(low, high):
    """Build a validator for a finite number within an inclusive range."""

    def validate(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        if not low <= value <= high:
            return None
        value = round(value, 2)
        return int(value) if value.is_integer() else value

    return validate


def _validate_work_days(value):
    """A non-empty, duplicate-free list of weekday numbers (Monday is 0)."""
    if not isinstance(value, list):
        return None

    clean = []
    for day in value:
        if isinstance(day, bool) or not isinstance(day, int) or not 0 <= day <= 6:
            return None
        if day not in clean:
            clean.append(day)
    return sorted(clean) if clean else None


def _validate_work_calendar_overrides(value):
    """Validate and normalise date-range work-calendar rules.

    A rule may override the work/non-work status, the hours for each working
    day, or both. An optional weekday filter applies it only to selected days
    inside the range. Reset flags explicitly restore either field to the
    effective schedule default. Rules are intentionally ordered: when ranges
    overlap, the later rule wins independently for each field.
    """
    if not isinstance(value, list):
        return None

    clean = []
    seen_ids = set()
    for item in value:
        if not isinstance(item, dict):
            return None

        rule_id = item.get('id')
        if not isinstance(rule_id, str) or not rule_id.strip() or len(rule_id) > 80:
            return None
        rule_id = rule_id.strip()
        if rule_id in seen_ids:
            return None

        try:
            start = date.fromisoformat(item.get('start_date', ''))
            end = date.fromisoformat(item.get('end_date', ''))
        except (TypeError, ValueError):
            return None
        if end < start:
            return None

        weekdays = item.get('weekdays')
        if weekdays is not None:
            weekdays = _validate_work_days(weekdays)
            if weekdays is None:
                return None

        is_workday = item.get('is_workday')
        if is_workday is not None and not isinstance(is_workday, bool):
            return None

        reset_workday = item.get('reset_workday', False)
        reset_hours = item.get('reset_hours', False)
        if not isinstance(reset_workday, bool) or not isinstance(reset_hours, bool):
            return None
        if reset_workday and is_workday is not None:
            return None

        hours = item.get('hours_per_day')
        if hours is not None:
            if isinstance(hours, bool) or not isinstance(hours, (int, float)):
                return None
            hours = float(hours)
            if not WORK_HOURS_PER_DAY_MIN <= hours <= WORK_HOURS_PER_DAY_MAX:
                return None
            hours = round(hours, 2)
        if reset_hours and hours is not None:
            return None

        if (
            is_workday is None
            and hours is None
            and not reset_workday
            and not reset_hours
        ):
            return None

        clean.append({
            'id': rule_id,
            'start_date': start.isoformat(),
            'end_date': end.isoformat(),
            'weekdays': weekdays,
            'is_workday': is_workday,
            'hours_per_day': hours,
            'reset_workday': reset_workday,
            'reset_hours': reset_hours,
        })
        seen_ids.add(rule_id)

    return clean


def _validate_work_schedule_history(value):
    """Validate effective-dated snapshots of the default work schedule."""
    if not isinstance(value, list):
        return None

    clean = []
    seen_dates = set()
    validate_hours = _validate_number(
        WORK_HOURS_PER_DAY_MIN, WORK_HOURS_PER_DAY_MAX
    )
    for item in value:
        if not isinstance(item, dict):
            return None
        try:
            effective = date.fromisoformat(item.get('effective_from', ''))
        except (TypeError, ValueError):
            return None
        if effective in seen_dates:
            return None

        hours = validate_hours(item.get('hours_per_day'))
        work_days = _validate_work_days(item.get('work_days'))
        if hours is None or work_days is None:
            return None

        clean.append({
            'effective_from': effective.isoformat(),
            'hours_per_day': hours,
            'work_days': work_days,
        })
        seen_dates.add(effective)

    clean.sort(key=lambda item: item['effective_from'])
    return clean


# key -> (default, validator). The validator returns a cleaned value, or None to
# reject it and fall back to the default.
_SCHEMA = {
    'theme': ('auto', _validate_choice(THEME_CHOICES)),
    # How clock times are presented in the UI. API and database values remain
    # canonical 24-hour clock strings regardless of this display preference.
    'time_format': ('12h', _validate_choice(TIME_FORMAT_CHOICES)),
    # One policy controls reports, History, Today, and budget allocation. It is
    # intentionally not effective-dated: changes recalculate historical time.
    'rounding_enabled': (True, _validate_bool),
    'rounding_interval_minutes': (
        15,
        _validate_int(ROUNDING_INTERVAL_MIN, ROUNDING_INTERVAL_MAX),
    ),
    'rounding_direction': (
        'nearest',
        _validate_choice(ROUNDING_DIRECTION_CHOICES),
    ),
    # Windows toast nudging you to describe the task you're currently on.
    'reminder_enabled': (True, _validate_bool),
    'reminder_interval_minutes': (
        30,
        _validate_int(REMINDER_INTERVAL_MIN, REMINDER_INTERVAL_MAX),
    ),
    'reminder_snooze_minutes': (
        10,
        _validate_int(REMINDER_SNOOZE_MIN, REMINDER_SNOOZE_MAX),
    ),
    # How much you normally work on each selected recurring workday, before
    # date-specific exceptions are layered on top.
    'work_hours_per_day': (
        8,
        _validate_number(WORK_HOURS_PER_DAY_MIN, WORK_HOURS_PER_DAY_MAX),
    ),
    # The recurring workweek and exceptions layered over it. Keeping these in
    # the settings file means holidays and temporary schedules survive a
    # database reset alongside the daily-hours preference they refine.
    'work_days': (DEFAULT_WORK_DAYS, _validate_work_days),
    'work_calendar_overrides': ([], _validate_work_calendar_overrides),
    # Snapshots are created automatically whenever either default changes.
    # They keep historical budget calculations fixed while the newest values
    # remain the convenient top-level settings used by the editor.
    'work_schedule_history': ([], _validate_work_schedule_history),
}

# Lists must not be shared with callers, especially the override editor which
# mutates its local copy before PUTting it back.
DEFAULTS = {
    key: list(default) if isinstance(default, list) else default
    for key, (default, _) in _SCHEMA.items()
}

# Reads happen on every request (the context processor) and writes come from the
# settings page; Flask serves those on different threads.
_lock = threading.Lock()


def _coerce(raw):
    """Project an arbitrary dict onto the schema, filling in defaults."""
    if not isinstance(raw, dict):
        raw = {}
    else:
        raw = dict(raw)

    # Compatibility for both earlier capacity models. Weekly hours divide by
    # the saved recurring workdays; the older monthly value first uses the
    # app's historical four-week conversion. Legacy keys disappear on the next
    # atomic write because neither is in the current schema.
    if 'work_hours_per_day' not in raw:
        work_days = _validate_work_days(raw.get('work_days')) or DEFAULT_WORK_DAYS
        legacy_weekly = raw.get('work_hours_per_week')
        if (
            isinstance(legacy_weekly, (int, float))
            and not isinstance(legacy_weekly, bool)
            and 0.25 <= float(legacy_weekly) <= 168
        ):
            converted = float(legacy_weekly) / len(work_days)
        else:
            legacy_monthly = raw.get('work_hours_per_month')
            if (
                isinstance(legacy_monthly, (int, float))
                and not isinstance(legacy_monthly, bool)
                and 1 <= float(legacy_monthly) <= 744
            ):
                converted = (float(legacy_monthly) / 4) / len(work_days)
            else:
                converted = None

        if converted is not None:
            converted = min(WORK_HOURS_PER_DAY_MAX, round(converted, 2))
            if converted >= WORK_HOURS_PER_DAY_MIN:
                raw['work_hours_per_day'] = converted

    clean = {}
    for key, (default, validate) in _SCHEMA.items():
        if key in raw:
            value = validate(raw[key])
            if value is None:
                clean[key] = list(default) if isinstance(default, list) else default
            else:
                clean[key] = value
        else:
            clean[key] = list(default) if isinstance(default, list) else default
    return clean


def _read_file():
    try:
        with open(SETTINGS_PATH, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except FileNotFoundError:
        # First run. Not an error.
        return {}
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        # Corrupt or unreadable. Better to run on defaults than refuse to start;
        # the next save rewrites the file cleanly.
        print(f'Could not read settings, using defaults: {exc}')
        return {}


def _write_file(data):
    os.makedirs(USER_DATA_DIR, exist_ok=True)

    # Temp file in the *same* directory so os.replace is a real atomic rename
    # (it isn't across volumes).
    handle, temp_path = tempfile.mkstemp(
        prefix='.settings-', suffix='.tmp', dir=USER_DATA_DIR
    )
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, indent=2)
            fh.write('\n')
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temp_path, SETTINGS_PATH)
    except BaseException:
        # Don't leave stray temp files behind if anything went wrong.
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def load_settings():
    """Return the full settings dict, defaults filled in. Never raises."""
    with _lock:
        return _coerce(_read_file())


def get_setting(key):
    """Return one setting's value, or its default."""
    return load_settings().get(key, DEFAULTS.get(key))


def update_settings(changes, effective_date=None):
    """Merge `changes` into the stored settings and persist.

    Unknown keys are ignored and invalid values fall back to the default, so a
    malformed request can't corrupt the file. Returns the resulting settings.
    """
    if not isinstance(changes, dict):
        changes = {}

    with _lock:
        current = _coerce(_read_file())
        merged = dict(current)
        merged.update({k: v for k, v in changes.items() if k in _SCHEMA})
        clean = _coerce(merged)

        schedule_changed = (
            clean['work_hours_per_day'] != current['work_hours_per_day']
            or clean['work_days'] != current['work_days']
        )
        if schedule_changed:
            effective_date = effective_date or date.today()
            effective_iso = effective_date.isoformat()
            history = [dict(item) for item in current['work_schedule_history']]

            # The first change needs a baseline for every earlier date. Later
            # changes already have one, so they only add/replace today's row.
            if not history:
                history.append({
                    'effective_from': date.min.isoformat(),
                    'hours_per_day': current['work_hours_per_day'],
                    'work_days': list(current['work_days']),
                })

            version = {
                'effective_from': effective_iso,
                'hours_per_day': clean['work_hours_per_day'],
                'work_days': list(clean['work_days']),
            }
            existing = next(
                (
                    index
                    for index, item in enumerate(history)
                    if item['effective_from'] == effective_iso
                ),
                None,
            )
            if existing is None:
                history.append(version)
            else:
                history[existing] = version
            history.sort(key=lambda item: item['effective_from'])
            clean['work_schedule_history'] = history

        if clean != current or not os.path.exists(SETTINGS_PATH):
            _write_file(clean)
        return clean
