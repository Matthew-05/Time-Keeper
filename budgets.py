"""Budget allocation and capacity maths.

Two independent halves, kept in one module because every useful number needs
both:

**Allocation** — which recorded hours count against which budget. A budget
stores no running total; consumption is recomputed from the tasks on every
read. That's deliberate. Time entries are edited constantly in the Task Browser
(start and end times get corrected, clients get reassigned), and any stored
total would be wrong within minutes with no way to notice.

**Capacity** — how much working time a date range actually contains, from the
user's daily hours, recurring workweek, and date-range overrides. This is
what turns "18 of 40 hours used" into "you're on pace for 47", which is the
number that's actually actionable.

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

from rounding import round_seconds_to_hours

DEFAULT_WORK_DAYS = frozenset({0, 1, 2, 3, 4})

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
    """Compatibility helper for the original nearest-quarter rule.

    Mirrors ``main.round_to_quarter_hour`` and ``totalTimeSpentToFractionalHours``
    in the frontend. Half-up rather than Python's banker's rounding, so the three
    of them agree on exact 7.5-minute boundaries.
    """
    return round_seconds_to_hours(seconds)


# --------------------------------------------------------------------------
# Capacity
# --------------------------------------------------------------------------


def _work_days_set(work_days):
    """Defensively turn a setting value into weekday numbers."""
    try:
        return frozenset(int(day) for day in work_days if not isinstance(day, bool))
    except (TypeError, ValueError):
        return DEFAULT_WORK_DAYS


def _rule_date(value):
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _schedule_for_day(day, hours_per_day, work_days, schedule_versions):
    """Return the effective default schedule without altering old dates."""
    selected = None
    selected_date = None
    for version in schedule_versions or ():
        if not isinstance(version, dict):
            continue
        effective = _rule_date(version.get('effective_from'))
        if effective is None or effective > day:
            continue
        if selected_date is None or effective > selected_date:
            selected = version
            selected_date = effective

    if selected is None:
        return float(hours_per_day), _work_days_set(work_days)

    try:
        hours = float(selected['hours_per_day'])
        days = _work_days_set(selected['work_days'])
        return hours, days
    except (KeyError, TypeError, ValueError):
        return float(hours_per_day), _work_days_set(work_days)


def workday_details(
    day,
    hours_per_day,
    work_days=DEFAULT_WORK_DAYS,
    overrides=(),
    schedule_versions=(),
):
    """Resolve one date against the recurring week and ordered range rules.

    Status and hours cascade independently. This lets one broad rule set a
    temporary daily amount while a later holiday rule only marks a smaller
    range non-working. The last matching value for each field wins.
    """
    default_hours, default_days = _schedule_for_day(
        day, hours_per_day, work_days, schedule_versions
    )
    default_is_workday = day.weekday() in default_days
    is_workday = default_is_workday
    hours_override = None
    status_overridden = False
    hours_overridden = False
    status_rule_id = None
    hours_rule_id = None

    for rule in overrides or ():
        if not isinstance(rule, dict):
            continue
        start = _rule_date(rule.get('start_date'))
        end = _rule_date(rule.get('end_date'))
        if start is None or end is None or not start <= day <= end:
            continue

        weekdays = rule.get('weekdays')
        if weekdays is not None:
            try:
                if day.weekday() not in {int(value) for value in weekdays}:
                    continue
            except (TypeError, ValueError):
                continue

        if rule.get('reset_workday') is True:
            is_workday = default_is_workday
            status_overridden = False
            status_rule_id = None
        elif rule.get('is_workday') is not None:
            is_workday = bool(rule['is_workday'])
            status_overridden = True
            status_rule_id = rule.get('id')
        if rule.get('reset_hours') is True:
            hours_override = None
            hours_overridden = False
            hours_rule_id = None
        elif rule.get('hours_per_day') is not None:
            try:
                hours_override = float(rule['hours_per_day'])
                hours_overridden = True
                hours_rule_id = rule.get('id')
            except (TypeError, ValueError):
                pass

    hours = hours_override if hours_overridden else default_hours

    return {
        'is_workday': is_workday,
        'hours': hours if is_workday else 0.0,
        # The chosen amount before non-working status zeros capacity. The
        # calendar editor needs this to populate an hours override on an off
        # day without losing the configured value.
        'configured_hours': hours,
        'default_hours': default_hours,
        'status_overridden': status_overridden,
        'hours_overridden': hours_overridden,
        'active_rule_ids': list(dict.fromkeys(
            rule_id
            for rule_id in (status_rule_id, hours_rule_id)
            if rule_id is not None
        )),
    }


def business_days_in_month(year, month, work_days=DEFAULT_WORK_DAYS):
    """Recurring workday count for a calendar month."""
    _first_weekday, days = calendar.monthrange(year, month)
    work_days = _work_days_set(work_days)
    return sum(
        1
        for day in range(1, days + 1)
        if date(year, month, day).weekday() in work_days
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


def day_capacity(
    day,
    hours_per_day,
    held=frozenset(),
    work_days=DEFAULT_WORK_DAYS,
    overrides=(),
    schedule_versions=(),
):
    """Working hours available on `day`.

    Each recurring workday contributes the configured daily amount. Changing
    the recurring workweek therefore adds or removes whole days of capacity
    instead of redistributing a fixed weekly total across them.

    Recurring non-work days and dates explicitly marked non-working are zero.
    That's the whole reason this isn't a plain calendar-day run rate: checking
    a budget before time off shouldn't show a pace diluted by days nobody
    works.

    **Held days are zero for exactly the same reason.** A project on hold has
    days in its range that nobody was ever going to work, and diluting the pace
    with them is the same mistake as diluting it with a weekend — just larger,
    because a hold can run for weeks. `held` is a set of dates from
    ``hold_days``; passing it is what makes every figure in this module
    hold-aware, and passing nothing gives the pre-holds behaviour exactly.
    """
    if day in held:
        return 0.0
    return workday_details(
        day, hours_per_day, work_days, overrides, schedule_versions
    )['hours']


def capacity_between(
    start,
    end,
    hours_per_day,
    held=frozenset(),
    work_days=DEFAULT_WORK_DAYS,
    overrides=(),
    schedule_versions=(),
):
    """Total working hours in the inclusive range, or 0.0 if it's empty."""
    if end < start:
        return 0.0

    total = 0.0
    # Whole months are the common case for a range of any length; walking day
    # by day is still only a few hundred iterations for a year and keeps the
    # partial-month edges honest.
    day = start
    while day <= end:
        total += day_capacity(
            day,
            hours_per_day,
            held,
            work_days,
            overrides,
            schedule_versions,
        )
        day += timedelta(days=1)
    return total


def business_days_between(
    start,
    end,
    held=frozenset(),
    work_days=DEFAULT_WORK_DAYS,
    overrides=(),
    schedule_versions=(),
):
    """Configured working-day count across the inclusive range."""
    if end < start:
        return 0
    total = 0
    day = start
    while day <= end:
        if (
            day not in held
            and workday_details(
                day, 1, work_days, overrides, schedule_versions
            )['is_workday']
        ):
            total += 1
        day += timedelta(days=1)
    return total


# --------------------------------------------------------------------------
# Allocation
# --------------------------------------------------------------------------


def raw_hours_by_task(tasks, now=None):
    """Return each entry's actual duration, without inventing entry rounding.

    Company rounding happens once at the client-day boundary. An entry is
    therefore always a raw fact; only a day's destination ledger has a
    billable value.
    """
    now = now or datetime.now()
    return {task.id: task_seconds(task, now) / 3600.0 for task in tasks}


def billable_hours_by_task(tasks, now=None, rounding_policy=None):
    """Return legacy per-entry billable shares, rounded per client-day.

    Budget allocation deliberately uses :func:`raw_hours_by_task` because an
    entry itself is a raw fact. This compatibility helper retains its original
    contract for reports and older callers: round each complete client-day,
    then apportion that billable total across its entries deterministically.
    """
    now = now or datetime.now()
    tasks = list(tasks)
    result_seconds = {task.id: 0 for task in tasks}
    groups = {}
    for task in tasks:
        key = (getattr(task, 'client_id', None), task.date)
        groups.setdefault(key, []).append(task)

    for day_tasks in groups.values():
        weights = {task.id: task_seconds(task, now) for task in day_tasks}
        rounded_hours = round_seconds_to_hours(sum(weights.values()), rounding_policy)
        rounded_seconds = max(0, int(round(rounded_hours * 3600)))
        result_seconds.update(
            _largest_remainder(weights, rounded_seconds, sort_key=lambda task_id: task_id)
        )
    return {
        task_id: seconds / 3600.0
        for task_id, seconds in result_seconds.items()
    }


def _largest_remainder(weights, total, sort_key):
    """Apportion an integer total proportionally with deterministic ties."""
    result = {key: 0 for key in weights}
    weight_total = sum(weights.values())
    if weight_total <= 0 or total <= 0:
        return result

    ranked = []
    assigned = 0
    for key in sorted(weights, key=sort_key):
        quota = total * weights[key] / weight_total
        whole = math.floor(quota)
        result[key] = whole
        assigned += whole
        ranked.append((quota - whole, key))

    ranked.sort(key=lambda item: (-item[0], sort_key(item[1])))
    for _remainder, key in ranked[:total - assigned]:
        result[key] += 1
    return result


def _destination_sort_key(destination):
    """Stable ordering for largest-remainder ties."""
    kind, budget_id = destination
    order = {
        'budget': 0,
        'no_budget': 1,
        'auto_pool': 2,
        'excluded': 3,
        'unbudgeted': 4,
    }
    return (order.get(kind, 99), budget_id if budget_id is not None else -1)


def _apportion_day(destinations, rounded_seconds):
    """Apportion integer billable seconds using deterministic remainders."""
    return _largest_remainder(
        {key: value['raw_seconds'] for key, value in destinations.items()},
        rounded_seconds,
        sort_key=_destination_sort_key,
    )


def _partition_subshares(weights, total):
    """Split a destination's exact seconds for explanatory sub-rows.

    This is intentionally not another largest-remainder allocation. The only
    authoritative allocation is the client-day destination apportionment. The
    reason rows are a presentation breakdown of an already-fixed No-budget
    destination, using cumulative boundaries so their integer pieces still
    reconcile exactly.
    """
    result = {key: 0 for key in weights}
    weight_total = sum(weights.values())
    if weight_total <= 0 or total <= 0:
        return result
    assigned = 0
    cumulative = 0.0
    ordered = sorted(weights)
    for key in ordered[:-1]:
        cumulative += weights[key]
        boundary = int(round(total * cumulative / weight_total))
        result[key] = boundary - assigned
        assigned = boundary
    result[ordered[-1]] = total - assigned
    return result


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


def allocation_ledger(budgets, tasks, now=None, rounding_policy=None):
    """Round known day categories once, then pour the integer automatic pool.

    Returns ``(used, entries, unbudgeted_hours, days)``. ``entries`` contains
    raw slices only. ``used`` and ``unbudgeted_hours`` come from the day ledger's
    billable destination amounts. Every day dictionary exposes its raw total,
    rounded total, adjustment, provisional state, and destination shares.

    A client-day's only largest-remainder pass has categories known before
    allocation: each pinned budget, one explicit/coverage-gap No-budget
    destination, and one pool for eligible automatic time. Exact pinned shares
    reserve capacity globally. Each day's already-integer automatic share then
    pours through integer budget headroom; its raw/billable ratio is used only
    to reconstruct the compatibility trace. Overflow lands on the last eligible
    budget, and no second rounding or apportionment is performed.
    """
    now = now or datetime.now()
    tasks = list(tasks)
    raw_seconds = {task.id: task_seconds(task, now) for task in tasks}
    by_id = {b.id: b for b in budgets}

    excluded = [t for t in tasks if getattr(t, 'budget_excluded', False)]
    eligible_tasks = [t for t in tasks if not getattr(t, 'budget_excluded', False)]
    pinned = [
        t for t in eligible_tasks
        if t.budget_id is not None and t.budget_id in by_id
    ]
    loose = [
        t for t in eligible_tasks
        if t.budget_id is None or t.budget_id not in by_id
    ]

    all_days = sorted({task.date for task in tasks})
    tasks_by_day = {}
    for task in tasks:
        tasks_by_day.setdefault(task.date, []).append(task)

    pinned_by_day = {}
    excluded_by_day = {}
    loose_by_day = {}
    for task in pinned:
        pinned_by_day.setdefault(task.date, []).append(task)
    for task in excluded:
        excluded_by_day.setdefault(task.date, []).append(task)
    loose.sort(key=lambda t: (t.date, t.start_time, t.id))
    for task in loose:
        loose_by_day.setdefault(task.date, []).append(task)

    # The categories are fixed facts, so this is the sole LR pass for each day.
    day_plans = {}
    for day in all_days:
        day_tasks = tasks_by_day[day]
        total_raw_seconds = sum(raw_seconds[task.id] for task in day_tasks)
        rounded_hours = round_seconds_to_hours(total_raw_seconds, rounding_policy)
        rounded_seconds = max(0, int(round(rounded_hours * 3600)))
        covering = eligible_budgets(budgets, day)
        categories = {}

        def add_category(destination, seconds):
            category = categories.setdefault(destination, {'raw_seconds': 0.0})
            category['raw_seconds'] += seconds

        for task in pinned_by_day.get(day, []):
            add_category(('budget', task.budget_id), raw_seconds[task.id])
        for task in excluded_by_day.get(day, []):
            add_category(('no_budget', None), raw_seconds[task.id])
        for task in loose_by_day.get(day, []):
            destination = ('auto_pool', None) if covering else ('no_budget', None)
            add_category(destination, raw_seconds[task.id])

        category_shares = _apportion_day(categories, rounded_seconds)
        day_plans[day] = {
            'raw_seconds': total_raw_seconds,
            'rounded_seconds': rounded_seconds,
            'covering': covering,
            'category_shares': category_shares,
            'auto_raw_seconds': categories.get(
                ('auto_pool', None), {'raw_seconds': 0.0}
            )['raw_seconds'],
            'auto_billable_seconds': category_shares.get(('auto_pool', None), 0),
            'pinned_billable_seconds': {
                budget_id: seconds
                for (kind, budget_id), seconds in category_shares.items()
                if kind == 'budget'
            },
            'no_budget_billable_seconds': category_shares.get(
                ('no_budget', None), 0
            ),
        }

    split = {}
    per_day = {}

    def record(task, destination, seconds, is_pinned=False, reason=None):
        budget_id = destination[1] if destination[0] == 'budget' else None
        split.setdefault(task.id, []).append(
            (budget_id, seconds / 3600.0, is_pinned)
        )
        day_destinations = per_day.setdefault(task.date, {})
        part = day_destinations.setdefault(
            destination,
            {
                'raw_seconds': 0.0,
                'task_ids': set(),
                'reason_raw_seconds': {},
                'reason_task_ids': {},
            },
        )
        part['raw_seconds'] += seconds
        part['task_ids'].add(task.id)
        reason = reason or destination[0]
        part['reason_raw_seconds'][reason] = (
            part['reason_raw_seconds'].get(reason, 0.0) + seconds
        )
        part['reason_task_ids'].setdefault(reason, set()).add(task.id)

    for task in pinned:
        record(task, ('budget', task.budget_id), raw_seconds[task.id], True)
    for task in excluded:
        record(
            task,
            ('no_budget', None),
            raw_seconds[task.id],
            reason='excluded',
        )
    for day, day_tasks in loose_by_day.items():
        if not day_plans[day]['covering']:
            for task in day_tasks:
                record(
                    task,
                    ('no_budget', None),
                    raw_seconds[task.id],
                    reason='coverage_gap',
                )

    budget_capacity = {
        budget.id: max(0, int(round(budget.budgeted_hours * 3600)))
        for budget in budgets
    }
    capacity_used = {budget.id: 0 for budget in budgets}
    for plan in day_plans.values():
        for budget_id, seconds in plan['pinned_billable_seconds'].items():
            capacity_used[budget_id] += seconds

    auto_billable_by_day = {}
    for day in all_days:
        plan = day_plans[day]
        auto_billable = plan['auto_billable_seconds']
        remaining = auto_billable
        allocations = []
        for index, budget in enumerate(plan['covering']):
            last = index == len(plan['covering']) - 1
            headroom = budget_capacity[budget.id] - capacity_used[budget.id]
            take = remaining if last else min(remaining, max(0, headroom))
            if take > 0:
                allocations.append([budget.id, take])
                capacity_used[budget.id] += take
                remaining -= take
            if remaining <= 0:
                break
        auto_billable_by_day[day] = allocations

        auto_tasks = loose_by_day.get(day, []) if plan['covering'] else []
        if not auto_tasks:
            continue
        if auto_billable <= 0 or plan['auto_raw_seconds'] <= 0:
            destination = ('budget', plan['covering'][0].id)
            for task in auto_tasks:
                record(task, destination, raw_seconds[task.id])
            continue

        scale = auto_billable / plan['auto_raw_seconds']
        allocation_index = 0
        billable_left = allocations[0][1]
        for task in auto_tasks:
            task_raw_left = raw_seconds[task.id]
            if task_raw_left <= 0:
                record(task, ('budget', allocations[allocation_index][0]), 0.0)
                continue
            while task_raw_left > 1e-7:
                budget_id = allocations[allocation_index][0]
                last_allocation = allocation_index == len(allocations) - 1
                take_raw = (
                    task_raw_left
                    if last_allocation
                    else min(task_raw_left, billable_left / scale)
                )
                record(task, ('budget', budget_id), take_raw)
                task_raw_left -= take_raw
                billable_left -= take_raw * scale
                if not last_allocation and billable_left <= 1e-7:
                    allocation_index += 1
                    billable_left = allocations[allocation_index][1]

    used_seconds = {b.id: 0 for b in budgets}
    unbudgeted_seconds = 0
    days = []

    for day in all_days:
        plan = day_plans[day]
        destinations = per_day.get(day, {})
        total_raw_seconds = plan['raw_seconds']
        rounded_seconds = plan['rounded_seconds']
        apportioned = {
            ('budget', budget_id): seconds
            for budget_id, seconds in plan['pinned_billable_seconds'].items()
        }
        for budget_id, seconds in auto_billable_by_day[day]:
            destination = ('budget', budget_id)
            apportioned[destination] = apportioned.get(destination, 0) + seconds
        if ('no_budget', None) in destinations:
            apportioned[('no_budget', None)] = plan['no_budget_billable_seconds']
        destination_rows = []

        for destination in sorted(destinations, key=_destination_sort_key):
            kind, budget_id = destination
            raw_value = destinations[destination]['raw_seconds']
            billable_value = apportioned.get(destination, 0)
            if kind == 'budget':
                used_seconds[budget_id] += billable_value
            reason_shares = {}
            if kind == 'no_budget':
                raw_seconds_by_reason = destinations[destination][
                    'reason_raw_seconds'
                ]
                reason_billable = _partition_subshares(
                    raw_seconds_by_reason, billable_value
                )
                for reason, reason_raw_seconds in raw_seconds_by_reason.items():
                    reason_billable_seconds = reason_billable.get(reason, 0)
                    reason_shares[reason] = {
                        'raw_hours': reason_raw_seconds / 3600.0,
                        'billable_hours': reason_billable_seconds / 3600.0,
                        'rounding_adjustment_hours': (
                            reason_billable_seconds - reason_raw_seconds
                        ) / 3600.0,
                        'task_ids': sorted(
                            destinations[destination]['reason_task_ids'][reason]
                        ),
                    }
                unbudgeted_seconds += reason_billable.get('coverage_gap', 0)

            destination_rows.append({
                'kind': kind,
                'reason': (
                    next(iter(reason_shares))
                    if len(reason_shares) == 1 else 'mixed'
                ) if reason_shares else kind,
                'budget_id': budget_id,
                'raw_hours': raw_value / 3600.0,
                'billable_hours': billable_value / 3600.0,
                'rounding_adjustment_hours': (billable_value - raw_value) / 3600.0,
                'reason_shares': reason_shares,
                'task_ids': sorted(destinations[destination]['task_ids']),
            })

        days.append({
            'date': day,
            'raw_hours': total_raw_seconds / 3600.0,
            'rounded_hours': rounded_seconds / 3600.0,
            'rounding_adjustment_hours': (rounded_seconds - total_raw_seconds) / 3600.0,
            # Today's total can change when another entry is added even if no
            # timer is currently running, so the whole current day is tentative.
            'provisional': day == now.date(),
            'destinations': destination_rows,
        })

    used = {budget_id: seconds / 3600.0 for budget_id, seconds in used_seconds.items()}
    return used, split, unbudgeted_seconds / 3600.0, days


def allocate(budgets, tasks, now=None, rounding_policy=None):
    """Compatibility wrapper returning the allocator's original three values."""
    used, split, unbudgeted, _days = allocation_ledger(
        budgets, tasks, now, rounding_policy
    )
    return used, split, unbudgeted


def rounding_days_for_budget(ledger, budget_id):
    """Return JSON-safe day totals and reason-level No-budget shares."""
    rows = []
    for client_day in ledger:
        budget_destination = next(
            (
                destination for destination in client_day['destinations']
                if destination['kind'] == 'budget'
                and destination['budget_id'] == budget_id
            ),
            None,
        )
        no_budget = [
            destination for destination in client_day['destinations']
            if destination['kind'] == 'no_budget'
        ]
        if budget_destination is None and not no_budget:
            continue

        def total(destinations, field):
            return sum(destination[field] for destination in destinations)

        def seconds(hours):
            return int(round(hours * 3600))

        no_budget_reasons = {}
        for destination in no_budget:
            for reason, share in destination.get('reason_shares', {}).items():
                totals = no_budget_reasons.setdefault(
                    reason,
                    {
                        'raw_hours': 0.0,
                        'billable_hours': 0.0,
                        'rounding_adjustment_hours': 0.0,
                        'task_ids': set(),
                    },
                )
                totals['raw_hours'] += share['raw_hours']
                totals['billable_hours'] += share['billable_hours']
                totals['rounding_adjustment_hours'] += share[
                    'rounding_adjustment_hours'
                ]
                totals['task_ids'].update(share.get('task_ids', []))

        serialized_reasons = {
            reason: {
                'raw_hours': round(share['raw_hours'], 6),
                'raw_seconds': seconds(share['raw_hours']),
                'billable_hours': round(share['billable_hours'], 6),
                'billable_seconds': seconds(share['billable_hours']),
                'rounding_adjustment_hours': round(
                    share['rounding_adjustment_hours'], 6
                ),
                'rounding_adjustment_seconds': seconds(
                    share['rounding_adjustment_hours']
                ),
                'task_ids': sorted(share['task_ids']),
            }
            for reason, share in sorted(no_budget_reasons.items())
        }

        rows.append({
            'date': client_day['date'].isoformat(),
            'raw_hours': round(client_day['raw_hours'], 6),
            'raw_seconds': seconds(client_day['raw_hours']),
            'rounded_hours': round(client_day['rounded_hours'], 6),
            'rounded_seconds': seconds(client_day['rounded_hours']),
            'rounding_adjustment_hours': round(
                client_day['rounding_adjustment_hours'], 6
            ),
            'rounding_adjustment_seconds': seconds(
                client_day['rounding_adjustment_hours']
            ),
            'provisional': client_day['provisional'],
            'budget_raw_hours': round(
                budget_destination['raw_hours'] if budget_destination else 0.0, 6
            ),
            'budget_raw_seconds': seconds(
                budget_destination['raw_hours'] if budget_destination else 0.0
            ),
            'budget_billable_hours': round(
                budget_destination['billable_hours'] if budget_destination else 0.0, 6
            ),
            'budget_billable_seconds': seconds(
                budget_destination['billable_hours']
                if budget_destination else 0.0
            ),
            'budget_rounding_adjustment_hours': round(
                budget_destination['rounding_adjustment_hours']
                if budget_destination else 0.0,
                6,
            ),
            'budget_rounding_adjustment_seconds': seconds(
                budget_destination['rounding_adjustment_hours']
                if budget_destination else 0.0
            ),
            'no_budget_raw_hours': round(total(no_budget, 'raw_hours'), 6),
            'no_budget_raw_seconds': seconds(total(no_budget, 'raw_hours')),
            'no_budget_billable_hours': round(total(no_budget, 'billable_hours'), 6),
            'no_budget_billable_seconds': seconds(
                total(no_budget, 'billable_hours')
            ),
            'no_budget_rounding_adjustment_hours': round(
                total(no_budget, 'rounding_adjustment_hours'), 6
            ),
            'no_budget_rounding_adjustment_seconds': seconds(
                total(no_budget, 'rounding_adjustment_hours')
            ),
            'no_budget_reasons': serialized_reasons,
        })
    return rows


# --------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------


# A straight-line pace estimate is too volatile during kickoff. Both gates are
# required before it is allowed to drive an at-risk warning; the raw estimate
# remains available to the detailed Budgets page as clearly labelled context.
MIN_PROJECTION_ELAPSED_PERCENT = 20.0
MIN_PROJECTION_ELAPSED_DAYS = 5


def _safe_divide(numerator, denominator):
    return None if not denominator else numerator / denominator


def status_for(
    percent_used,
    projected_percent,
    started,
    ended,
    paused=False,
    risk_threshold_percent=10.0,
    projection_mature=False,
):
    """One word for where a budget stands. Drives colour everywhere in the UI.

    ``over`` is about what has already happened; ``at_risk`` is about where the
    current average pace lands after it has enough history to be meaningful.
    Keeping them separate matters — a budget at 40% on day three of a month is
    fine, and the same 40% on day twenty-five is not. Each budget supplies its
    own tolerated pace-based overage, defaulting to 10%.

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
    if (
        projection_mature
        and projected_percent is not None
        and projected_percent > 100 + risk_threshold_percent
    ):
        return 'at_risk'
    return 'on_track'


def summarise(
    budget,
    used_hours,
    hours_per_day,
    today=None,
    holds=(),
    day_hours=None,
    work_days=DEFAULT_WORK_DAYS,
    calendar_overrides=(),
    schedule_versions=(),
):
    """Everything the UI shows about one budget, from its consumed hours.

    The projection is a capacity-weighted run rate: hours used, scaled by the
    ratio of the period's total working capacity to the capacity that has
    elapsed. Because capacity is zero at on days off spread across each
    configured workdays, this answers "at this rate, where do I finish"
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
    raw_risk_threshold = getattr(budget, 'risk_threshold_percent', None)
    risk_threshold = float(
        raw_risk_threshold if raw_risk_threshold is not None else 10.0
    )
    # Keep allocation precision for every decision and derived metric. Values
    # are rounded only when serialized below; otherwise a one-second overage
    # can disappear into a displayed 100.0% and be misclassified as in-budget.
    exact_used = float(used_hours)
    exact_remaining = budgeted - exact_used
    exact_percent_used = exact_used / budgeted * 100 if budgeted else None
    budgeted_seconds = int(round(budgeted * 3600))
    used_seconds = int(round(exact_used * 3600))
    remaining_seconds = budgeted_seconds - used_seconds
    over_by_seconds = max(0, used_seconds - budgeted_seconds)

    started = today >= budget.start_date
    manually_closed = getattr(budget, 'closed_at', None) is not None
    ended = manually_closed or today > budget.end_date
    elapsed_end = min(today, budget.end_date)
    paused = started and not ended and today in held

    total_capacity = capacity_between(
        budget.start_date,
        budget.end_date,
        hours_per_day,
        held,
        work_days,
        calendar_overrides,
        schedule_versions,
    )
    elapsed_capacity = (
        capacity_between(
            budget.start_date,
            elapsed_end,
            hours_per_day,
            held,
            work_days,
            calendar_overrides,
            schedule_versions,
        )
        if started
        else 0.0
    )
    remaining_capacity = max(0.0, total_capacity - elapsed_capacity)

    total_days = business_days_between(
        budget.start_date,
        budget.end_date,
        held,
        work_days,
        calendar_overrides,
        schedule_versions,
    )
    elapsed_days = (
        business_days_between(
            budget.start_date,
            elapsed_end,
            held,
            work_days,
            calendar_overrides,
            schedule_versions,
        )
        if started
        else 0
    )
    exact_percent_elapsed = (
        elapsed_capacity / total_capacity * 100
        if total_capacity
        else None
    )
    projection_mature = (
        exact_percent_elapsed is not None
        and exact_percent_elapsed >= MIN_PROJECTION_ELAPSED_PERCENT
        and elapsed_days >= MIN_PROJECTION_ELAPSED_DAYS
    )
    # Today is spent, so tomorrow is the first day still available.
    remaining_days = business_days_between(
        max(budget.start_date, today + timedelta(days=1)),
        budget.end_date,
        held,
        work_days,
        calendar_overrides,
        schedule_versions,
    )

    ratio = _safe_divide(total_capacity, elapsed_capacity)
    exact_projected = exact_used * ratio if ratio is not None else None
    exact_projected_percent = (
        exact_projected / budgeted * 100
        if exact_projected is not None and budgeted
        else None
    )

    pace = _safe_divide(exact_used, elapsed_days)
    # What you can average from tomorrow and still land exactly on budget.
    required_pace = (
        _safe_divide(exact_remaining, remaining_days) if remaining_days else None
    )

    # Working days the holds removed from this budget's own range. Configured
    # days off aren't counted — they were never capacity, so claiming a hold
    # "cost" them would overstate what the pause actually took.
    held_working_days = sum(
        1
        for day in held
        if budget.start_date <= day <= budget.end_date
        and workday_details(
            day,
            hours_per_day,
            work_days,
            calendar_overrides,
            schedule_versions,
        )['is_workday']
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
            day_capacity(
                resumes_on,
                hours_per_day,
                held,
                work_days,
                calendar_overrides,
                schedule_versions,
            ) <= 0
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
        'budgeted_seconds': budgeted_seconds,
        'risk_threshold_percent': round(risk_threshold, 2),
        'notes': budget.notes,
        'closed_at': budget.closed_at.isoformat() if manually_closed else None,

        'used_hours': round(exact_used, 2),
        'remaining_hours': round(exact_remaining, 2),
        'used_seconds': used_seconds,
        'remaining_seconds': remaining_seconds,
        'percent_used': (
            round(exact_percent_used, 1)
            if exact_percent_used is not None else None
        ),
        'percent_used_exact': (
            exact_percent_used
            if exact_percent_used is not None else None
        ),
        'over_by': round(max(0.0, exact_used - budgeted), 2),
        'over_by_seconds': over_by_seconds,

        'projected_hours': (
            round(exact_projected, 2) if exact_projected is not None else None
        ),
        'projected_percent': (
            round(exact_projected_percent, 1)
            if exact_projected_percent is not None else None
        ),
        'projected_overage': (
            round(exact_projected - budgeted, 2)
            if exact_projected is not None else None
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
            round(exact_percent_elapsed, 1)
            if exact_percent_elapsed is not None else None
        ),
        'projection_mature': projection_mature,

        'started': started,
        'ended': ended,
        # Deliberately *not* narrowed by `paused`. "In force right now" is what
        # the Today widget filters on, and a paused engagement is still the one
        # you'd be recording against — seeing it there with a paused badge is
        # the point. Pausing shouldn't make a budget vanish from the screen you
        # log time on.
        'is_active': started and not ended,
        'status': status_for(
            exact_percent_used,
            exact_projected_percent,
            started,
            ended,
            paused,
            risk_threshold,
            projection_mature,
        ),

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


def burn_series(
    budget,
    day_hours,
    hours_per_day,
    today=None,
    holds=(),
    work_days=DEFAULT_WORK_DAYS,
    calendar_overrides=(),
    schedule_versions=(),
):
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
        budget.start_date,
        budget.end_date,
        hours_per_day,
        held,
        work_days,
        calendar_overrides,
        schedule_versions,
    )
    budgeted = float(budget.budgeted_hours)

    points = []
    cumulative = 0.0
    spent_capacity = 0.0

    day = budget.start_date
    while day <= budget.end_date:
        spent_capacity += day_capacity(
            day,
            hours_per_day,
            held,
            work_days,
            calendar_overrides,
            schedule_versions,
        )
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
