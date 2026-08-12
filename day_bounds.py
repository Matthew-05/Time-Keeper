"""Where the untracked time in a day is, and what a new task does to the day.

Both questions come from the same place: adding a task to a day after the fact,
on the History page. Nobody adds one at random — they add one because they can
see a stretch of the day with nothing against it and they remember what they
were doing. So the app finds those stretches and offers the biggest as the
default, which turns "what time did I start, what time did I stop" into one
click for the common case.

The second question is what happens when the task lands outside the day. A day
whose recorded bounds don't contain its own tasks is incoherent — the History
page derives non-billable time as "day length minus tracked time", so a task
after the day's end makes that figure negative. Rather than refuse the task
(the task is the true record; the bounds are the guess) the day is stretched to
fit. It's confirmed first, because silently moving a day's end is the kind of
edit someone needs to know happened.

Flask-free and database-free, the same split `budgets.py`, `summary.py` and
`day_close.py` use: `main.py` owns the queries and the writes, this owns the
arithmetic.

Times here are plain ``datetime.time`` and every interval is half-open —
``[start, end)``. That is what makes back-to-back tasks not overlap: a task
ending at 11:00 and one starting at 11:00 share an instant and nothing more.
"""

from collections import namedtuple

#: Gaps shorter than this aren't worth offering. Between two tasks recorded a
#: minute apart there is nothing anyone means to fill in, and a list of
#: two-minute suggestions buries the twenty-minute one that was the point.
MINIMUM_GAP_MINUTES = 5

#: The new bounds a day needs to contain a task. ``None`` in either field means
#: that end of the day already covers it and must not be touched.
Stretch = namedtuple('Stretch', 'start end')


def _minutes_between(start, end):
    return (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute)


def find_gaps(window_start, window_end, busy):
    """Stretches of ``[window_start, window_end)`` that no interval in ``busy`` covers.

    Pure geometry: **every** gap, however short. Judging which are worth
    offering belongs to `suggest_gap`, because the two callers want different
    answers from the same data — the day strip draws all of them so that what's
    on screen adds up to the day, and the form's default ignores the slivers.

    ``busy`` is any iterable of ``(start, end)`` and need not be sorted or
    disjoint — overlapping tasks are a state the Task Browser can be edited
    into, and this is not the place to complain about it, so they're merged by
    walking a high-water mark rather than assumed away.

    A window that is missing an end (a day still in progress) or inverted has
    no meaningful interior, so it yields nothing. Callers pass the current time
    as ``window_end`` for today.
    """
    if window_start is None or window_end is None or window_end <= window_start:
        return []

    gaps = []
    cursor = window_start

    for start, end in sorted(busy):
        if end <= cursor:
            # Wholly behind the high-water mark — a task nested inside one
            # already consumed, or an out-of-order row.
            continue
        if start >= window_end:
            break
        if start > cursor:
            gaps.append((cursor, min(start, window_end)))
        cursor = max(cursor, end)
        if cursor >= window_end:
            break

    if cursor < window_end:
        gaps.append((cursor, window_end))

    return gaps


def largest_gap(gaps):
    """The longest gap, earliest first on a tie, or None if there are none.

    Earliest-wins matters more than it looks: two equal gaps usually means a
    lunch break was never recorded on either side of it, and the morning one is
    the one being reconstructed.
    """
    if not gaps:
        return None
    return max(gaps, key=lambda gap: _minutes_between(*gap))


def suggest_gap(gaps, minimum_minutes=MINIMUM_GAP_MINUTES):
    """The gap a form should open on, or None if none is worth offering.

    The threshold lives here rather than in `find_gaps` because a sliver is
    still a real part of the day — it belongs on the strip, where leaving it
    out would make the drawing stop adding up. It just isn't a sensible
    default for two time fields.
    """
    return largest_gap([gap for gap in gaps if _minutes_between(*gap) >= minimum_minutes])


def plan_stretch(day_start, day_end, task_start, task_end):
    """The day bounds that would have to move to contain ``[task_start, task_end)``.

    Returns a :class:`Stretch` whose fields are the *new* values, or None where
    the existing bound already covers the task and must be left alone.

    A day with no recorded **end** is a day still in progress, and a day in
    progress contains everything by definition — there is no bound to move, so
    nothing is proposed and the user isn't asked to confirm a change that
    wouldn't happen. A day with no recorded **start** is a different thing: a
    broken row rather than an open one, and filling it in from the task is
    strictly better than leaving the day unanchored.
    """
    return Stretch(
        task_start if day_start is None or task_start < day_start else None,
        task_end if day_end is not None and task_end > day_end else None,
    )


def needs_stretch(stretch):
    """Would applying this move anything? Cheaper to read than the two `is not None`s."""
    return stretch.start is not None or stretch.end is not None
