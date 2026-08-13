"""Client-day manual time adjustment arithmetic.

An adjustment is deliberately scoped to a client and date.  The stored value
is a signed number of minutes, while the base remains derived from the tasks so
editing those tasks cannot leave a stale copied total in the database.

The editor always starts from the client's raw tracked total.  The adjusted
value is then treated as the new input to the rounding policy.  With rounding
disabled, that adjusted value is the final billable value directly.
"""

from rounding import normalize_policy, round_seconds_to_hours


def rounded_seconds(seconds, policy=None):
    """Return ``seconds`` after applying the normalized rounding policy."""
    return max(0, int(round(round_seconds_to_hours(seconds, policy) * 3600)))


def adjustment_figures(tracked_seconds, adjustment_minutes=None, policy=None):
    """Return the raw, editable, adjusted, and final client-day totals.

    ``adjustment_minutes=None`` means no manual override exists and preserves
    the application's original behavior exactly: actual time is the raw task
    duration and billable time is its rounded form.  A numeric value, including
    zero, means a manual override exists.
    """
    policy = normalize_policy(policy)
    tracked_seconds = max(0, int(round(float(tracked_seconds or 0))))
    ordinary_billable = rounded_seconds(tracked_seconds, policy)

    if adjustment_minutes is None:
        return {
            'tracked_seconds': tracked_seconds,
            'base_seconds': tracked_seconds,
            'adjustment_seconds': None,
            'adjusted_seconds': tracked_seconds,
            'billable_seconds': ordinary_billable,
            'has_adjustment': False,
        }

    adjustment_seconds = int(adjustment_minutes) * 60
    base_seconds = tracked_seconds
    adjusted_seconds = base_seconds + adjustment_seconds
    if adjusted_seconds < 0:
        raise ValueError('Adjusted time cannot be negative')

    return {
        'tracked_seconds': tracked_seconds,
        'base_seconds': base_seconds,
        'adjustment_seconds': adjustment_seconds,
        'adjusted_seconds': adjusted_seconds,
        'billable_seconds': rounded_seconds(adjusted_seconds, policy),
        'has_adjustment': True,
    }
