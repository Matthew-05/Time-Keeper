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
from pathlib import Path

# Same directory the database lives in — see main.py.
USER_DATA_DIR = os.path.join(Path.home(), 'AppData', 'Local', 'TimeKeeper')
SETTINGS_PATH = os.path.join(USER_DATA_DIR, 'settings.json')

THEME_CHOICES = ('light', 'dark', 'auto')

# Bounds for the description reminder. The UI enforces these too, but a
# hand-edited file or a stale client shouldn't be able to set a 0-minute
# interval and turn the reminder into a firehose.
REMINDER_INTERVAL_MIN = 1
REMINDER_INTERVAL_MAX = 480  # 8 hours — longer than a working day.
REMINDER_SNOOZE_MIN = 1
REMINDER_SNOOZE_MAX = 120

# Working hours in a month, which is what every budget projection is measured
# against (see budgets.py). The floor is 1 rather than 0 because a zero would
# make capacity zero and every projection undefined; the ceiling is a little
# over 24×31 so a typo can't produce a negative-looking pace.
WORK_HOURS_PER_MONTH_MIN = 1
WORK_HOURS_PER_MONTH_MAX = 744


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


# key -> (default, validator). The validator returns a cleaned value, or None to
# reject it and fall back to the default.
_SCHEMA = {
    'theme': ('auto', _validate_choice(THEME_CHOICES)),
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
    # How much you actually work in a month. Budgets spread this across each
    # month's weekdays to decide how much of a period has really elapsed, which
    # is what makes "% used" comparable to "% of the period gone". 160 is a
    # 40-hour week; part-timers and anyone billing a fixed retainer will want
    # their own number.
    'work_hours_per_month': (
        160,
        _validate_int(WORK_HOURS_PER_MONTH_MIN, WORK_HOURS_PER_MONTH_MAX),
    ),
}

DEFAULTS = {key: default for key, (default, _) in _SCHEMA.items()}

# Reads happen on every request (the context processor) and writes come from the
# settings page; Flask serves those on different threads.
_lock = threading.Lock()


def _coerce(raw):
    """Project an arbitrary dict onto the schema, filling in defaults."""
    if not isinstance(raw, dict):
        raw = {}

    clean = {}
    for key, (default, validate) in _SCHEMA.items():
        if key in raw:
            value = validate(raw[key])
            clean[key] = default if value is None else value
        else:
            clean[key] = default
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


def update_settings(changes):
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

        if clean != current or not os.path.exists(SETTINGS_PATH):
            _write_file(clean)
        return clean
