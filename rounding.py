"""Shared time-rounding policy.

The app rounds one client-day at a time. This module owns the arithmetic so
reporting and budget calculations cannot disagree about interval boundaries or
rounding direction. It deliberately has no Flask or settings dependency;
callers pass the already-validated global policy in.
"""

import math


DEFAULT_POLICY = {
    'enabled': True,
    'interval_minutes': 15,
    'direction': 'nearest',
}
VALID_DIRECTIONS = frozenset({'nearest', 'up', 'down'})


def normalize_policy(policy=None):
    """Return a defensive, complete policy dict."""
    policy = policy if isinstance(policy, dict) else {}

    enabled = policy.get('enabled', DEFAULT_POLICY['enabled'])
    if not isinstance(enabled, bool):
        enabled = DEFAULT_POLICY['enabled']

    interval = policy.get(
        'interval_minutes', DEFAULT_POLICY['interval_minutes']
    )
    if (
        isinstance(interval, bool)
        or not isinstance(interval, (int, float))
        or not float(interval).is_integer()
        or not 1 <= int(interval) <= 60
    ):
        interval = DEFAULT_POLICY['interval_minutes']
    else:
        interval = int(interval)

    direction = policy.get('direction', DEFAULT_POLICY['direction'])
    if direction not in VALID_DIRECTIONS:
        direction = DEFAULT_POLICY['direction']

    return {
        'enabled': enabled,
        'interval_minutes': interval,
        'direction': direction,
    }


def round_seconds_to_hours(seconds, policy=None):
    """Convert tracked seconds to hours using ``policy``.

    ``nearest`` uses half-up rounding. Python's built-in ``round`` uses
    banker's rounding, which would disagree on exact half-way values.
    """
    try:
        seconds = max(0.0, float(seconds))
    except (TypeError, ValueError):
        seconds = 0.0

    policy = normalize_policy(policy)
    if not policy['enabled']:
        return seconds / 3600.0

    interval_seconds = policy['interval_minutes'] * 60.0
    units = seconds / interval_seconds
    if policy['direction'] == 'up':
        rounded_units = math.ceil(units)
    elif policy['direction'] == 'down':
        rounded_units = math.floor(units)
    else:
        rounded_units = math.floor(units + 0.5)

    return rounded_units * interval_seconds / 3600.0
