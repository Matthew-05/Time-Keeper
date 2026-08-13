"""Aggregation for the Summary dashboard.

Flask-free and database-free, the same split `budgets.py` and `rounding.py`
already use: `main.py` owns the queries and the HTTP surface, this owns the
arithmetic. Callers hand over tracked seconds keyed by ``(client name, date)``
plus a callable that resolves one day's capacity, and get back the exact shapes
the dashboard renders.

Two rules run through all of it.

**Rounding happens per client per day, and nowhere else.** That is the unit the
History page rounds at and the unit that actually gets billed. A day is the sum
of its clients' rounded figures, a range is the sum of its days, and a client's
range total is the sum of that client's rounded days. Rounding any of those
totals again — or rounding a combined figure once at the end — produces a
different, usually smaller number, and then two cards on one page disagree.

**Every money-shaped figure ships as ``*_hours`` beside a ``*_amount`` that is
currently ``None``.** There are no rates in the schema yet. When there are,
those fields fill in and the frontend's single formatter is the only other
thing that has to change.

Figures also travel as exact ``*_seconds`` alongside the two-decimal
``*_hours`` the UI prints, the same pairing ``budgets.summarise`` uses, and
**every total is summed from the seconds**. Adding up the rounded hours instead
loses up to half a minute per client per day: two seven-minute entries are
0.12 hrs each on screen but 0.23 hrs together, not 0.24, and over a month that
drift is large enough to see.

**The dashboard describes elapsed time only.** ``day_rows`` still returns every
date in the window — the calendar grid needs a cell for each — but the overview
cuts that to ``elapsed()`` before rolling anything up, so the trend chart, the
client table and every figure in ``totals`` are all about days that have
actually happened. A Wednesday should not read as a third of a week wasted
because Thursday and Friday haven't arrived; that reading was already special-
cased for utilisation, and applying it everywhere is the only way the cards
agree with each other. Today counts as elapsed: time recorded this morning is
already in the numerator, so leaving today's capacity out of the denominator
would flatter every reading until midnight.
"""

from datetime import date, timedelta

from rounding import round_seconds_to_hours


def day_rows(
    start,
    end,
    seconds_by_client_day,
    capacity_for,
    policy=None,
    weekdays=None,
):
    """One row per date in ``[start, end]``, logged or not.

    ``seconds_by_client_day`` is ``{(client_name, date): tracked_seconds}``.
    ``capacity_for(day)`` returns ``(is_workday, hours)`` for one date.
    ``weekdays`` is an optional set of ISO weekday numbers (Monday is 0) to
    keep; ``None`` keeps every day.

    Empty days are included deliberately. The calendar needs a cell for every
    date, and a gap in the trend chart is information — dropping the days would
    draw a fortnight of leave as an unbroken line.
    """
    by_day = {}
    for (name, day), seconds in seconds_by_client_day.items():
        clients = by_day.setdefault(day, {})
        clients[name] = clients.get(name, 0) + seconds

    rows = []
    day = start
    while day <= end:
        if weekdays is not None and day.weekday() not in weekdays:
            day += timedelta(days=1)
            continue

        clients = sorted(
            (
                _figures({
                    'client_name': name,
                    'billable_seconds': int(round(
                        round_seconds_to_hours(seconds, policy) * 3600
                    )),
                    'tracked_seconds': int(round(seconds)),
                })
                for name, seconds in by_day.get(day, {}).items()
            ),
            key=lambda entry: (-entry['billable_seconds'], entry['client_name']),
        )
        is_workday, hours = capacity_for(day)

        rows.append(_figures({
            'date': day.isoformat(),
            'billable_seconds': sum(c['billable_seconds'] for c in clients),
            'tracked_seconds': sum(c['tracked_seconds'] for c in clients),
            # Zero rather than the resolved amount on a non-working day, so
            # utilisation can be a plain sum of this column.
            'capacity_hours': hours if is_workday else 0.0,
            'is_workday': is_workday,
            'clients': clients,
        }))
        day += timedelta(days=1)

    return rows


def _figures(entry):
    """Add the printable hours (and the null amount) beside the exact seconds.

    One place, so a payload can never carry an hours field that disagrees with
    the seconds beside it.
    """
    entry['billable_hours'] = round(entry['billable_seconds'] / 3600, 2)
    entry['tracked_hours'] = round(entry['tracked_seconds'] / 3600, 2)
    entry['billable_amount'] = None
    return entry


def client_rollup(rows):
    """Per-client totals across ``rows``, largest first."""
    totals_by_client = {}
    for row in rows:
        for entry in row['clients']:
            client = totals_by_client.setdefault(entry['client_name'], {
                'client_name': entry['client_name'],
                'client_color': entry.get('client_color'),
                'billable_seconds': 0,
                'tracked_seconds': 0,
                'days_worked': 0,
            })
            client['billable_seconds'] += entry['billable_seconds']
            client['tracked_seconds'] += entry['tracked_seconds']
            # A day the client appears on at all. An entry short enough to
            # round away to zero was still a day their work was touched.
            client['days_worked'] += 1

    billable_total = sum(c['billable_seconds'] for c in totals_by_client.values())
    rollup = []
    for client in totals_by_client.values():
        _figures(client)
        client['avg_billable_per_day'] = (
            round(client['billable_seconds'] / client['days_worked'] / 3600, 2)
            if client['days_worked'] else 0.0
        )
        client['share_percent'] = (
            round(client['billable_seconds'] / billable_total * 100, 1)
            if billable_total else None
        )
        rollup.append(client)

    rollup.sort(key=lambda client: (-client['billable_seconds'], client['client_name']))
    return rollup


def elapsed(rows, today=None):
    """``rows`` cut to the days that have actually happened, today included.

    Applied once, by the caller, before anything is rolled up — the alternative
    is every function here taking a ``today`` and each deciding for itself what
    counts, which is exactly how two cards on one page start to disagree.

    Not applied to the calendar's rows: that grid goes on painting amounts for
    dates outside the selection, and a month with days left in it should still
    draw the whole month.
    """
    today = (today or date.today()).isoformat()
    return [row for row in rows if row['date'] <= today]


def totals(rows, clients, selected=None):
    """The KPI strip, from the same rows every card below it uses.

    ``rows`` has already been through `elapsed()`, so every figure below
    describes the part of the range that has happened and none of them need to
    know today's date. ``selected`` is the range *before* that cut, and is used
    for nothing but saying how much of the selection is still ahead — the
    difference between "3 days" and "3 of 7 days" is the whole reason a
    Wednesday reading doesn't look like a bad week.
    """
    selected = rows if selected is None else selected

    billable_seconds = sum(row['billable_seconds'] for row in rows)
    tracked_seconds = sum(row['tracked_seconds'] for row in rows)
    capacity = round(sum(row['capacity_hours'] for row in rows), 2)
    workdays = sum(1 for row in rows if row['is_workday'])
    # "Worked" is any day with time on it, not any day with billable hours: a
    # ten-minute entry that rounds down to zero was still a day at the desk.
    worked = [row for row in rows if row['tracked_seconds'] > 0]
    busiest = max(worked, key=lambda row: row['billable_seconds'], default=None)
    billable = round(billable_seconds / 3600, 2)

    # Days the daily average is taken over: every scheduled workday, plus any
    # other day that was actually billed. Dividing by every calendar day would
    # drag the figure down by weekends nobody was ever going to work; dividing
    # only by days worked answers a different question, and
    # `avg_billable_per_worked_day` above already answers that one.
    #
    # The numerator stays the elapsed billable total, which is the same thing as
    # the total across these days — a day outside the set is by definition a
    # non-working day with nothing billed on it.
    active = [
        row for row in rows
        if row['is_workday'] or row['billable_seconds'] > 0
    ]

    # Time billed on days the schedule never asked for. Counted separately
    # rather than folded into utilisation, because a Saturday adds to the
    # numerator without adding any capacity to the denominator: without this
    # figure beside it, weekend work reads as a productive week rather than as
    # a week that spilled.
    off_days = [row for row in rows if not row['is_workday']]
    off_billable = sum(row['billable_seconds'] for row in off_days)
    off_tracked = sum(row['tracked_seconds'] for row in off_days)
    off_worked = [row for row in off_days if row['tracked_seconds'] > 0]

    return {
        'billable_hours': billable,
        'billable_seconds': billable_seconds,
        'tracked_hours': round(tracked_seconds / 3600, 2),
        'tracked_seconds': tracked_seconds,
        'billable_amount': None,
        # What the rounding policy is worth over the range. Positive is time
        # billed that wasn't tracked; negative is tracked time given away.
        'rounding_delta_hours': round((billable_seconds - tracked_seconds) / 3600, 2),
        'capacity_hours': capacity,
        'utilisation_percent': (
            round(billable_seconds / 3600 / capacity * 100, 1)
            if capacity else None
        ),
        'workdays': workdays,
        'days_in_range': len(rows),
        # The selection as clicked, elapsed or not. Context for a label, never
        # a denominator.
        'days_selected': len(selected),
        'workdays_selected': sum(1 for row in selected if row['is_workday']),
        'days_worked': len(worked),
        'avg_billable_per_worked_day': (
            round(billable_seconds / len(worked) / 3600, 2) if worked else 0.0
        ),
        'active_days': len(active),
        'avg_billable_per_active_day': (
            round(billable_seconds / len(active) / 3600, 2) if active else 0.0
        ),
        # A mean, because capacity moves across a range whenever an override
        # does — so the pair below is "a typical day billed" against "a typical
        # day scheduled" rather than two figures for one particular day.
        'avg_capacity_per_workday': round(capacity / workdays, 2) if workdays else 0.0,
        # Those two as a ratio. Deliberately *not* the same question as
        # utilisation: this one divides by the average scheduled day, so a
        # weekend that was worked pulls it down (one more day billed, no more
        # capacity) where it pushes utilisation up. The two agreeing means
        # nothing was worked off-schedule.
        'avg_vs_capacity_percent': (
            round(billable_seconds / len(active) / 3600 / (capacity / workdays) * 100, 1)
            if active and workdays and capacity else None
        ),
        'non_working': _figures({
            'billable_seconds': off_billable,
            'tracked_seconds': off_tracked,
            'days': len(off_days),
            'days_worked': len(off_worked),
        }),
        'busiest_day': {
            'date': busiest['date'],
            'billable_hours': busiest['billable_hours'],
        } if busiest else None,
        'client_count': len(clients),
        # Share taken by the largest client — the one number that says whether
        # this was a diversified period or a single engagement in a trenchcoat.
        'top_client_share_percent': clients[0]['share_percent'] if clients else None,
    }


def parse_weekdays(raw):
    """``"0,3"`` as a set of ISO weekday numbers; ``None`` means every day.

    Returns ``(weekdays, error)``. The calendar's weekday-heading gesture picks
    every Monday in a month, and a start/end pair cannot express that, so the
    filter travels beside the range rather than being folded into it.
    """
    raw = (raw or '').strip()
    if not raw:
        return None, None

    try:
        days = {int(part) for part in raw.split(',') if part}
    except ValueError:
        return None, 'Expected weekdays as comma-separated numbers, Monday is 0.'
    if not days or any(not 0 <= day <= 6 for day in days):
        return None, 'Weekday numbers run 0 (Monday) to 6 (Sunday).'
    return days, None


def parse_window(start_raw, end_raw, limit_days):
    """Two ISO date strings as a window.

    Returns ``(start, end, None)`` or ``(None, None, message)``. A backwards
    range is reported rather than silently swapped: it is far more likely to be
    a bug in the caller than something the user meant.
    """
    try:
        start = date.fromisoformat(start_raw or '')
        end = date.fromisoformat(end_raw or '')
    except (TypeError, ValueError):
        return None, None, 'Expected ISO start and end dates.'

    if end < start:
        return None, None, 'The end date must follow the start date.'
    if (end - start).days > limit_days:
        return None, None, f'Summary windows are limited to {limit_days} days.'
    return start, end, None
