"""Budget allocation and capacity maths.

Two independent halves, kept in one module because every useful number needs
both:

**Allocation** — which recorded hours count against which budget. A budget
stores no running total; consumption is recomputed from the tasks on every
read. That's deliberate. Time entries are edited constantly in the Task Browser
(start and end times get corrected, clients get reassigned), and any stored
total would be wrong within minutes with no way to notice.

**Capacity** — how much working time a date range actually contains, from the
user's ``work_hours_per_month`` setting. This is what turns "18 of 40 hours
used" into "you're on pace for 47", which is the number that's actually
actionable.

Nothing here touches Flask or the request context; it takes rows and returns
dicts, so it can be exercised directly.
"""

import calendar
import math
from datetime import date, datetime, timedelta

# A budget's date range is inclusive at both ends, and so is every loop here.
# Written once so the off-by-one lives in exactly one place.


# --------------------------------------------------------------------------
# Duration
# --------------------------------------------------------------------------


def task_seconds(task, now=None):
    """How long a task ran, in seconds.

    Duplicated deliberately from ``main.task_duration_seconds`` so this module
    stays importable on its own; the rule is identical and must stay that way:
    an unfinished task counts up to now only on today's date, and never counts
    negative.
    """
    now = now or datetime.now()

    end = task.end_time
    if end is None:
        if task.date != now.date():
            return 0
        end = now.time()

    delta = (
        datetime.combine(task.date, end) - datetime.combine(task.date, task.start_time)
    ).total_seconds()
    return max(0.0, delta)


def round_to_quarter_hour(seconds):
    """Seconds -> hours rounded to the nearest quarter, half up.

    Mirrors ``main.round_to_quarter_hour`` and ``totalTimeSpentToFractionalHours``
    in the frontend. Half-up rather than Python's banker's rounding, so the three
    of them agree on exact 7.5-minute boundaries.
    """
    return math.floor(seconds / 900.0 + 0.5) / 4.0


# --------------------------------------------------------------------------
# Capacity
# --------------------------------------------------------------------------


def business_days_in_month(year, month):
    """Mon–Fri count for a calendar month. Never zero for a real month."""
    _first_weekday, days = calendar.monthrange(year, month)
    return sum(
        1
        for day in range(1, days + 1)
        if date(year, month, day).weekday() < 5
    )


def day_capacity(day, hours_per_month):
    """Working hours available on `day`.

    The user tells us hours per *month*; months have different numbers of
    working days, so the monthly figure is spread evenly across that month's
    weekdays rather than assuming a fixed 21.7. February and a 23-weekday
    August therefore both come out at the stated monthly total, which is what
    somebody entering "160" means.

    Weekends are zero. That's the whole reason this isn't a plain calendar-day
    run rate: checking a budget on a Friday afternoon shouldn't show a pace
    that's about to be diluted by two days nobody works.
    """
    if day.weekday() >= 5:
        return 0.0
    return hours_per_month / business_days_in_month(day.year, day.month)


def capacity_between(start, end, hours_per_month):
    """Total working hours in the inclusive range, or 0.0 if it's empty."""
    if end < start:
        return 0.0

    total = 0.0
    # Whole months are the common case for a range of any length; walking day
    # by day is still only a few hundred iterations for a year and keeps the
    # partial-month edges honest.
    day = start
    while day <= end:
        total += day_capacity(day, hours_per_month)
        day += timedelta(days=1)
    return total


def business_days_between(start, end):
    """Mon–Fri count across the inclusive range."""
    if end < start:
        return 0
    total = 0
    day = start
    while day <= end:
        if day.weekday() < 5:
            total += 1
        day += timedelta(days=1)
    return total


# --------------------------------------------------------------------------
# Allocation
# --------------------------------------------------------------------------


def billable_hours_by_task(tasks, now=None):
    """Per-task hours that sum, within a client-day, to the billable figure.

    The house rule is that time is rounded to the quarter hour per client per
    day — that's what the History page shows and what gets invoiced. But a pin
    is per *task*, so allocation needs a per-task number that still adds up to
    the rounded day.

    So each day's rounding difference is spread across that day's tasks in
    proportion to their length. A 20-minute and a 40-minute task on a day that
    rounds 1:00 to 1.0 stay at 1/3 and 2/3 of it. The alternative — allocating
    raw seconds and rounding at the end — would let a budget's total disagree
    with the same client-day total shown everywhere else in the app.

    A day whose raw time is zero contributes nothing, which also keeps the
    scale factor from dividing by zero.
    """
    now = now or datetime.now()

    raw = {}
    per_day = {}
    for task in tasks:
        seconds = task_seconds(task, now)
        raw[task.id] = seconds
        per_day[task.date] = per_day.get(task.date, 0.0) + seconds

    scale = {}
    for day, seconds in per_day.items():
        if seconds <= 0:
            scale[day] = 0.0
        else:
            scale[day] = round_to_quarter_hour(seconds) / (seconds / 3600.0)

    return {
        task.id: (raw[task.id] / 3600.0) * scale[task.date]
        for task in tasks
    }


def eligible_budgets(budgets, day):
    """Budgets covering `day`, in fill order.

    **Earliest end date first.** Overlapping budgets are consumed in the order
    they expire, so hours land on the pot that's about to close rather than on
    one that has months left. Start date and then id break ties, purely so the
    order is stable across requests — an allocation that reshuffled itself
    between two page loads would be impossible to trust.
    """
    covering = [b for b in budgets if b.start_date <= day <= b.end_date]
    covering.sort(key=lambda b: (b.end_date, b.start_date, b.id))
    return covering


def allocate(budgets, tasks, now=None):
    """Distribute `tasks` across `budgets` for a single client.

    Returns ``(used, entries, unbudgeted_hours)``:

    - ``used`` — ``{budget_id: hours}``, which can exceed the budget's total;
      going over is a fact to display, not an error to suppress.
    - ``entries`` — ``{task_id: (budget_id_or_None, hours, pinned_bool)}``.
      One task can land in two budgets when it spills, so the same task id can
      appear in more than one entry; callers that need that detail read
      ``split`` below instead.
    - ``unbudgeted_hours`` — time on days no budget covers.

    Order of operations, and it matters:

    1. **Pins are honoured first, unconditionally**, before any pouring. A
       pinned entry is the user overruling the allocator, so it consumes its
       budget's capacity ahead of everything else and is never spilled
       elsewhere — including when that puts the budget over, and including when
       the entry's date falls outside the budget's own range. Silently ignoring
       a pin the user set is far worse than showing them an overage they can
       see and fix.
    2. **Everything else pours chronologically** into whatever capacity is
       left. Chronological because the fill has to be reproducible and has to
       match intuition: the hours you worked first are the hours that consumed
       the budget first.
    3. **Overflow lands on the last eligible budget.** Once every budget
       covering a day is full, the remainder still has to be counted somewhere
       or the numbers stop reconciling — so it goes on the pot that expires
       last, as visible overage.
    """
    now = now or datetime.now()

    hours = billable_hours_by_task(tasks, now)
    by_id = {b.id: b for b in budgets}

    used = {b.id: 0.0 for b in budgets}
    split = {}
    unbudgeted = 0.0

    pinned = [t for t in tasks if t.budget_id is not None and t.budget_id in by_id]
    loose = [t for t in tasks if t.budget_id is None or t.budget_id not in by_id]

    for task in pinned:
        amount = hours.get(task.id, 0.0)
        used[task.budget_id] += amount
        split.setdefault(task.id, []).append((task.budget_id, amount, True))

    # Chronological, with id as the final tiebreaker so two entries sharing a
    # start time can't swap places between requests.
    loose.sort(key=lambda t: (t.date, t.start_time, t.id))

    for task in loose:
        remaining = hours.get(task.id, 0.0)
        if remaining <= 0:
            split.setdefault(task.id, []).append((None, 0.0, False))
            continue

        covering = eligible_budgets(budgets, task.date)
        if not covering:
            unbudgeted += remaining
            split.setdefault(task.id, []).append((None, remaining, False))
            continue

        for index, budget in enumerate(covering):
            headroom = budget.budgeted_hours - used[budget.id]
            last = index == len(covering) - 1

            if last:
                # Nowhere left to spill: take the whole remainder, overage and
                # all, so the client's hours always reconcile.
                take = remaining
            else:
                take = min(remaining, max(0.0, headroom))

            if take > 0:
                used[budget.id] += take
                split.setdefault(task.id, []).append((budget.id, take, False))
                remaining -= take

            if remaining <= 1e-9:
                break

    return used, split, unbudgeted


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------


def _safe_divide(numerator, denominator):
    return None if not denominator else numerator / denominator


def status_for(percent_used, projected_percent, started, ended):
    """One word for where a budget stands. Drives colour everywhere in the UI.

    ``over`` is about what has already happened; ``at_risk`` is about where the
    current pace lands. Keeping them separate matters — a budget at 40% on day
    three of a month is fine, and the same 40% on day twenty-five is not, and
    only the projection can tell them apart.
    """
    if percent_used is not None and percent_used > 100:
        return 'over'
    if not started:
        return 'upcoming'
    if ended:
        return 'closed'
    if projected_percent is not None and projected_percent > 105:
        return 'at_risk'
    return 'on_track'


def summarise(budget, used_hours, hours_per_month, today=None):
    """Everything the UI shows about one budget, from its consumed hours.

    The projection is a capacity-weighted run rate: hours used, scaled by the
    ratio of the period's total working capacity to the capacity that has
    elapsed. Because capacity is zero at weekends and spread across each
    month's actual weekdays, this answers "at this rate, where do I finish"
    without a Friday reading being dragged down by the weekend ahead of it or a
    short February reading like a slowdown.

    Today counts as fully elapsed. Time recorded this morning is already in
    ``used_hours``, so treating today as still ahead would inflate every
    projection until midnight.
    """
    today = today or date.today()

    budgeted = float(budget.budgeted_hours)
    used = round(used_hours, 2)
    remaining = round(budgeted - used, 2)
    percent_used = round(used / budgeted * 100, 1) if budgeted else None

    started = today >= budget.start_date
    ended = today > budget.end_date
    elapsed_end = min(today, budget.end_date)

    total_capacity = capacity_between(budget.start_date, budget.end_date, hours_per_month)
    elapsed_capacity = (
        capacity_between(budget.start_date, elapsed_end, hours_per_month)
        if started
        else 0.0
    )
    remaining_capacity = max(0.0, total_capacity - elapsed_capacity)

    total_days = business_days_between(budget.start_date, budget.end_date)
    elapsed_days = business_days_between(budget.start_date, elapsed_end) if started else 0
    # Today is spent, so tomorrow is the first day still available.
    remaining_days = business_days_between(
        max(budget.start_date, today + timedelta(days=1)), budget.end_date
    )

    ratio = _safe_divide(total_capacity, elapsed_capacity)
    projected = round(used * ratio, 2) if ratio is not None else None
    projected_percent = (
        round(projected / budgeted * 100, 1)
        if projected is not None and budgeted
        else None
    )

    pace = _safe_divide(used, elapsed_days)
    # What you can average from tomorrow and still land exactly on budget.
    required_pace = _safe_divide(remaining, remaining_days) if remaining_days else None

    return {
        'id': budget.id,
        'name': budget.name,
        'client_id': budget.client_id,
        'client_name': budget.client.name if budget.client else None,
        'start_date': budget.start_date.isoformat(),
        'end_date': budget.end_date.isoformat(),
        'budgeted_hours': round(budgeted, 2),
        'notes': budget.notes,

        'used_hours': used,
        'remaining_hours': remaining,
        'percent_used': percent_used,
        'over_by': round(max(0.0, used - budgeted), 2),

        'projected_hours': projected,
        'projected_percent': projected_percent,
        'projected_overage': (
            round(projected - budgeted, 2) if projected is not None else None
        ),

        'pace_hours_per_day': round(pace, 2) if pace is not None else None,
        'required_hours_per_day': (
            round(required_pace, 2) if required_pace is not None else None
        ),
        # What share of everything you could possibly work in this window the
        # budget represents. Over 100% means it isn't deliverable in the period
        # no matter how the rest of your clients behave.
        'capacity_share': (
            round(budgeted / total_capacity * 100, 1) if total_capacity else None
        ),

        'total_capacity_hours': round(total_capacity, 2),
        'elapsed_capacity_hours': round(elapsed_capacity, 2),
        'remaining_capacity_hours': round(remaining_capacity, 2),
        'total_business_days': total_days,
        'elapsed_business_days': elapsed_days,
        'remaining_business_days': remaining_days,
        'percent_elapsed': (
            round(elapsed_capacity / total_capacity * 100, 1) if total_capacity else None
        ),

        'started': started,
        'ended': ended,
        'is_active': started and not ended,
        'status': status_for(percent_used, projected_percent, started, ended),
    }


def burn_series(budget, day_hours, hours_per_month, today=None):
    """Cumulative actual vs. the capacity-paced ideal, one point per day.

    The ideal line isn't a straight diagonal: it tracks capacity, so it's flat
    across weekends and steps up on working days. Against a straight line every
    budget looks behind on a Monday and ahead on a Friday, which is noise
    rather than signal.

    Actual stops at today — drawing it flat into the future would read as "no
    work planned" rather than "hasn't happened yet".
    """
    today = today or date.today()

    total_capacity = capacity_between(budget.start_date, budget.end_date, hours_per_month)
    budgeted = float(budget.budgeted_hours)

    points = []
    cumulative = 0.0
    spent_capacity = 0.0

    day = budget.start_date
    while day <= budget.end_date:
        spent_capacity += day_capacity(day, hours_per_month)
        cumulative += day_hours.get(day, 0.0)

        points.append({
            'date': day.isoformat(),
            'actual': round(cumulative, 2) if day <= today else None,
            'ideal': round(
                budgeted * (spent_capacity / total_capacity) if total_capacity else 0.0,
                2,
            ),
        })
        day += timedelta(days=1)

    return points
