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

**Holds** live inside capacity rather than beside it. A paused project's days
are simply days that contribute nothing, which is what a weekend already is, so
the whole feature is one extra clause in ``day_capacity`` and everything
downstream — projection, pace, capacity share, the ideal line — corrects itself
without knowing holds exist.

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


def hold_days(holds, today=None):
    """The set of dates a budget was on hold. Empty set for no holds.

    Returned as a set of ``date`` so ``day_capacity`` can test membership in
    constant time inside its day-by-day walk. Budgets are months, not decades,
    so materialising the days costs nothing and keeps every caller identical.

    **An open hold (``end_date is None``) counts only up to today.** It's still
    running and its end is genuinely unknown, so the honest reading is "these
    days are gone, and tomorrow is available until proven otherwise". Extending
    an open hold to the budget's end instead would erase all remaining capacity
    and make ``required_hours_per_day`` report an impossible figure for a
    project that's merely waiting on somebody to reply — a paused project would
    look identical to a doomed one.

    Overlapping holds are fine and need no special handling: two intervals
    covering the same day put that day in the set once.
    """
    today = today or date.today()

    days = set()
    for hold in holds:
        end = hold.end_date if hold.end_date is not None else today
        day = hold.start_date
        while day <= end:
            days.add(day)
            day += timedelta(days=1)
    return days


def is_held(holds, day, today=None):
    """Whether `day` falls inside any hold. Convenience over ``hold_days``."""
    return day in hold_days(holds, today)


def day_capacity(day, hours_per_month, held=frozenset()):
    """Working hours available on `day`.

    The user tells us hours per *month*; months have different numbers of
    working days, so the monthly figure is spread evenly across that month's
    weekdays rather than assuming a fixed 21.7. February and a 23-weekday
    August therefore both come out at the stated monthly total, which is what
    somebody entering "160" means.

    Weekends are zero. That's the whole reason this isn't a plain calendar-day
    run rate: checking a budget on a Friday afternoon shouldn't show a pace
    that's about to be diluted by two days nobody works.

    **Held days are zero for exactly the same reason.** A project on hold has
    days in its range that nobody was ever going to work, and diluting the pace
    with them is the same mistake as diluting it with a weekend — just larger,
    because a hold can run for weeks. `held` is a set of dates from
    ``hold_days``; passing it is what makes every figure in this module
    hold-aware, and passing nothing gives the pre-holds behaviour exactly.
    """
    if day.weekday() >= 5 or day in held:
        return 0.0
    return hours_per_month / business_days_in_month(day.year, day.month)


def capacity_between(start, end, hours_per_month, held=frozenset()):
    """Total working hours in the inclusive range, or 0.0 if it's empty."""
    if end < start:
        return 0.0

    total = 0.0
    # Whole months are the common case for a range of any length; walking day
    # by day is still only a few hundred iterations for a year and keeps the
    # partial-month edges honest.
    day = start
    while day <= end:
        total += day_capacity(day, hours_per_month, held)
        day += timedelta(days=1)
    return total


def business_days_between(start, end, held=frozenset()):
    """Mon–Fri count across the inclusive range, excluding held days."""
    if end < start:
        return 0
    total = 0
    day = start
    while day <= end:
        if day.weekday() < 5 and day not in held:
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
    def effective_end(budget):
        closed_at = getattr(budget, 'closed_at', None)
        return min(budget.end_date, closed_at.date()) if closed_at else budget.end_date

    covering = [
        b for b in budgets if b.start_date <= day <= effective_end(b)
    ]
    covering.sort(key=lambda b: (effective_end(b), b.start_date, b.id))
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


def status_for(percent_used, projected_percent, started, ended, paused=False):
    """One word for where a budget stands. Drives colour everywhere in the UI.

    ``over`` is about what has already happened; ``at_risk`` is about where the
    current pace lands. Keeping them separate matters — a budget at 40% on day
    three of a month is fine, and the same 40% on day twenty-five is not, and
    only the projection can tell them apart.

    ``paused`` sits between the calendar facts and the pace verdict, and the
    order is the design:

    - **``over`` still wins.** An overspent budget doesn't stop being overspent
      because the project went quiet; that's the one thing you can't fix by
      resuming.
    - **``upcoming`` and ``closed`` still win**, because for a budget that
      hasn't started or has already ended the hold isn't the interesting fact
      about it.
    - **``paused`` outranks ``at_risk`` and ``on_track``**, because both of
      those are statements about pace, and a paused project has no pace. Saying
      "on track" about work that isn't happening is precisely the false comfort
      this whole feature exists to remove.
    """
    if percent_used is not None and percent_used > 100:
        return 'over'
    if not started:
        return 'upcoming'
    if ended:
        return 'closed'
    if paused:
        return 'paused'
    if projected_percent is not None and projected_percent > 105:
        return 'at_risk'
    return 'on_track'


def summarise(budget, used_hours, hours_per_month, today=None, holds=(), day_hours=None):
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

    ``holds`` are periods the project was paused. They're subtracted from both
    total and elapsed capacity, which is what keeps every derived figure honest
    across a pause and, crucially, after it: a budget resumed last week reads
    against the days actually worked, not against the fortnight nobody touched
    it. It also means this function stays agnostic about whether the deadline
    slipped. Extend ``end_date`` and the remaining capacity comes back; leave it
    and ``required_hours_per_day`` climbs, because the work really did get
    compressed. Both are correct answers to different situations, and neither
    needs a special case here.

    ``day_hours`` (``{date: hours}`` for this budget) is optional and only
    feeds ``held_hours`` — time recorded on days the project was supposedly on
    hold. It's never suppressed from ``used_hours``, because "a client's hours
    always reconcile" is load-bearing in ``allocate``; it's surfaced instead,
    since it almost always means the hold dates need correcting.
    """
    today = today or date.today()
    held = hold_days(holds, today)

    budgeted = float(budget.budgeted_hours)
    used = round(used_hours, 2)
    remaining = round(budgeted - used, 2)
    percent_used = round(used / budgeted * 100, 1) if budgeted else None

    started = today >= budget.start_date
    manually_closed = getattr(budget, 'closed_at', None) is not None
    ended = manually_closed or today > budget.end_date
    elapsed_end = min(today, budget.end_date)
    paused = started and not ended and today in held

    total_capacity = capacity_between(
        budget.start_date, budget.end_date, hours_per_month, held
    )
    elapsed_capacity = (
        capacity_between(budget.start_date, elapsed_end, hours_per_month, held)
        if started
        else 0.0
    )
    remaining_capacity = max(0.0, total_capacity - elapsed_capacity)

    total_days = business_days_between(budget.start_date, budget.end_date, held)
    elapsed_days = (
        business_days_between(budget.start_date, elapsed_end, held) if started else 0
    )
    # Today is spent, so tomorrow is the first day still available.
    remaining_days = business_days_between(
        max(budget.start_date, today + timedelta(days=1)), budget.end_date, held
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

    # Working days the holds removed from this budget's own range. Weekends
    # aren't counted — they were never capacity, so claiming a hold "cost" them
    # would overstate what the pause actually took.
    held_working_days = sum(
        1
        for day in held
        if budget.start_date <= day <= budget.end_date and day.weekday() < 5
    )
    held_hours = (
        round(sum(h for d, h in day_hours.items() if d in held), 2)
        if day_hours is not None
        else None
    )

    # The hold covering today, if any — what the UI needs to say "paused since
    # the 3rd, resumes Monday" rather than just "paused".
    current = next(
        (
            h
            for h in holds
            if h.start_date <= today and (h.end_date is None or today <= h.end_date)
        ),
        None,
    ) if paused else None

    resumes_on = None
    if current is not None and current.end_date is not None:
        # The next day with capacity, not the next day on the calendar. A hold
        # ending on a Friday resumes on the Monday, and telling somebody their
        # project restarts on Saturday is the kind of small wrongness that
        # makes people stop trusting the rest of the numbers. Also steps over a
        # hold that starts the moment this one ends.
        resumes_on = current.end_date + timedelta(days=1)
        while resumes_on <= budget.end_date and (
            resumes_on.weekday() >= 5 or resumes_on in held
        ):
            resumes_on += timedelta(days=1)

    return {
        'id': budget.id,
        'name': budget.name,
        'client_id': budget.client_id,
        'client_name': budget.client.name if budget.client else None,
        'start_date': budget.start_date.isoformat(),
        'end_date': budget.end_date.isoformat(),
        'budgeted_hours': round(budgeted, 2),
        'notes': budget.notes,
        'closed_at': budget.closed_at.isoformat() if manually_closed else None,

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
        # Deliberately *not* narrowed by `paused`. "In force right now" is what
        # the Today widget filters on, and a paused engagement is still the one
        # you'd be recording against — seeing it there with a paused badge is
        # the point. Pausing shouldn't make a budget vanish from the screen you
        # log time on.
        'is_active': started and not ended,
        'status': status_for(percent_used, projected_percent, started, ended, paused),

        'is_paused': paused,
        'paused_since': current.start_date.isoformat() if current else None,
        # None while an open-ended hold is running: the resumption date is
        # genuinely unknown, and inventing one would be worse than saying so.
        'resumes_on': resumes_on.isoformat() if resumes_on else None,
        'held_business_days': held_working_days,
        'held_hours': held_hours,
        'holds': [
            {
                'id': h.id,
                'start_date': h.start_date.isoformat(),
                'end_date': h.end_date.isoformat() if h.end_date else None,
                'reason': h.reason,
            }
            for h in sorted(holds, key=lambda h: h.start_date)
        ],
    }


def burn_series(budget, day_hours, hours_per_month, today=None, holds=()):
    """Cumulative actual vs. the capacity-paced ideal, one point per day.

    The ideal line isn't a straight diagonal: it tracks capacity, so it's flat
    across weekends and steps up on working days. Against a straight line every
    budget looks behind on a Monday and ahead on a Friday, which is noise
    rather than signal.

    Held days are flat for the same reason, and this is the most visible payoff
    of the whole holds design: without it the ideal line climbs across a
    three-week pause while actual can't move, inventing a huge underrun that
    then vanishes in a cliff on the day work resumes.

    ``held`` is reported per point so the chart can shade those spans. A flat
    stretch in the middle of the ideal line looks like a rendering fault unless
    the reason is drawn.

    Actual stops at today — drawing it flat into the future would read as "no
    work planned" rather than "hasn't happened yet".
    """
    today = today or date.today()
    held = hold_days(holds, today)

    total_capacity = capacity_between(
        budget.start_date, budget.end_date, hours_per_month, held
    )
    budgeted = float(budget.budgeted_hours)

    points = []
    cumulative = 0.0
    spent_capacity = 0.0

    day = budget.start_date
    while day <= budget.end_date:
        spent_capacity += day_capacity(day, hours_per_month, held)
        cumulative += day_hours.get(day, 0.0)

        points.append({
            'date': day.isoformat(),
            'actual': round(cumulative, 2) if day <= today else None,
            'ideal': round(
                budgeted * (spent_capacity / total_capacity) if total_capacity else 0.0,
                2,
            ),
            'held': day in held,
        })
        day += timedelta(days=1)

    return points
