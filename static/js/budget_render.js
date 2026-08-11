import { heading, insight, insightToSentence, note, row } from './insight.js'

/**
 * Shared budget rendering.
 *
 * The Budgets page and the Today-page widget show the same numbers at two
 * sizes, and the one thing that must never happen is the dashboard saying a
 * budget is fine while the Budgets page says it isn't. Every formatter and the
 * meter itself live here so there's exactly one implementation of "what does
 * 34.5 hours against 40 look like".
 */

/**
 * The one short statement of when a projection starts being trusted.
 *
 * Every surface that shows a pace figure has to say this, and each used to say
 * it at full length — "20% of the working period has elapsed and the budget is
 * five working days into its period — calendar working days, not days with time
 * recorded" — which is the wordiest sentence in the app and could appear three
 * times on one screen. One phrasing, reused; the full rule with the
 * calendar-vs-recorded caveat lives once, on the threshold field that sets it.
 */
export const MATURITY_RULE =
    'Treated as an early estimate until the budget is 20% through its working '
    + 'days and at least five in.'

/** Words for a status, in the order of how alarming they are. */
export const STATUS_LABEL = {
    on_track: 'Within budget',
    at_risk: 'At risk',
    over: 'Over budget',
    upcoming: 'Upcoming',
    closed: 'Closed',
    paused: 'On hold',
}

/**
 * Hours, to one decimal, without a trailing `.0` on whole numbers.
 *
 * Budgets are usually round figures — 40, 120, 7.5 — and rendering "40.0 hrs."
 * next to "40 hrs." in the same card reads like two different quantities.
 */
export function hours(value) {
    if (value == null || Number.isNaN(value)) return '—'
    const rounded = Math.round(value * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * The global rounding policy, or null when rounding is off.
 *
 * Read from the document on each call rather than captured at import time:
 * this module is loaded directly by the Node-based formatting tests, where
 * there is no document at all.
 */
export function roundingPolicy() {
    if (typeof document === 'undefined') return null
    const root = document.documentElement?.dataset
    if (!root || root.roundingEnabled !== 'true') return null
    const interval = Number(root.roundingIntervalMinutes)
    if (!Number.isInteger(interval) || interval < 1 || interval > 60) return null
    return { intervalMinutes: interval }
}

/**
 * How far off the interval a figure may sit and still count as on it.
 *
 * Purely a float guard: 3.25 arriving out of a division as 3.2499999996 is on
 * the quarter-hour grid in every sense that matters, and without a tolerance
 * `floor()` would drag it a whole interval down to 3. At a quarter-hour
 * interval this is worth about a hundredth of a second, so nothing real fits
 * inside it.
 */
const GRID_TOLERANCE = 1e-6

/**
 * Two decimals, only as many as the number needs: 3.5 stays "3.5", 2.25 stays
 * "2.25", 7 stays "7".
 *
 * Two is both the house precision for a policy-rounded figure and what the
 * server rounds to. An interval that isn't a clean fraction of an hour — seven
 * minutes, say — can't be printed exactly at any width, so there is nothing to
 * gain from going wider.
 */
function twoDecimals(value) {
    return Number(Number(value).toFixed(2)).toString()
}

/**
 * Hours printed against the rounding policy's grid.
 *
 * `hours()` shows one decimal, which under a 15-minute policy renders 3.25 as
 * "3.3" — a figure the policy could never have produced. Anything derived from
 * policy-rounded time gets printed here instead. With rounding disabled there
 * is no grid to print against and this is just `hours()`.
 *
 * By default nothing is moved that isn't already on the grid. A figure that
 * came out of the policy — used time, and anything a whole commitment is
 * subtracted from — lands on an interval to within float noise and prints
 * exactly. One that genuinely doesn't (remaining against an odd commitment, a
 * half-minute destination share) is printed as it stands rather than dragged
 * onto a grid it was never on, because a displayed figure that no arithmetic
 * on this page produces is worse than an awkward one.
 *
 * `direction` opts into real snapping, and exists for advice rather than for
 * totals: a remaining-pace figure rounds down so it never authorises more than
 * the budget holds, and an overage rounds up so it never flatters one.
 */
export function policyHours(value, { direction = null } = {}) {
    if (value == null || Number.isNaN(Number(value))) return '—'
    const policy = roundingPolicy()
    if (!policy) return hours(value)

    const step = policy.intervalMinutes / 60
    const units = Number(value) / step

    if (direction === 'down') return twoDecimals(Math.floor(units + GRID_TOLERANCE) * step)
    if (direction === 'up') return twoDecimals(Math.ceil(units - GRID_TOLERANCE) * step)

    const nearest = Math.round(units)
    return Math.abs(units - nearest) < GRID_TOLERANCE
        ? twoDecimals(nearest * step)
        : twoDecimals(value)
}

/**
 * A duration that preserves the ledger's whole-second apportionment.
 *
 * Destination shares can legitimately contain half-minutes (for example, a
 * 15-minute client-day split evenly across two budgets). Rounding each share
 * to a whole minute would make the visible pieces stop adding up to the day.
 */
export function exactDuration(value) {
    if (value == null || Number.isNaN(Number(value))) return '—'
    return exactDurationSeconds(Number(value) * 3600)
}

/** Format an already-apportioned second count without a lossy conversion. */
export function exactDurationSeconds(value) {
    if (value == null || Number.isNaN(Number(value))) return '—'
    const totalSeconds = Math.round(Math.abs(Number(value)))
    const wholeHours = Math.floor(totalSeconds / 3600)
    const wholeMinutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const parts = []
    if (wholeHours) parts.push(`${wholeHours}h`)
    if (wholeMinutes) parts.push(`${wholeMinutes}m`)
    if (seconds || !parts.length) parts.push(`${seconds}s`)
    return parts.join(' ')
}

/**
 * A duration to the minute — "41h 30m" — for summary figures.
 *
 * Seconds belong in the day-group tables, where a half-minute destination
 * share is the difference between the visible pieces adding up to the day and
 * not. A budget total is not that: nobody reconciles a 40-hour commitment to
 * the second, and "41h 30m 12s" in a summary card is noise around the two
 * figures anyone is actually reading.
 *
 * A non-zero amount is floored at "1m" rather than allowed to round away to
 * "0m". The case this form exists to survive is an Over badge sitting next to
 * its own magnitude, and a magnitude of nothing reads as a bug. A minute is
 * the smallest true thing this format can say, so a stray twenty seconds is
 * reported as one — an overstatement bounded by half a minute, which is the
 * cheaper error of the two.
 */
export function hourMinuteDuration(value) {
    if (value == null || Number.isNaN(Number(value))) return '—'
    const totalSeconds = Math.abs(Number(value))
    if (!totalSeconds) return '0m'
    const totalMinutes = Math.max(1, Math.round(totalSeconds / 60))

    const wholeHours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    const parts = []
    if (wholeHours) parts.push(`${wholeHours}h`)
    if (minutes || !wholeHours) parts.push(`${minutes}m`)
    return parts.join(' ')
}

/**
 * Summary duration that keeps familiar decimal hours unless exactness matters.
 *
 * Decimal hours go through `policyHours` rather than `hours`: every figure this
 * renders is either policy-rounded time or a commitment with policy-rounded
 * time taken out of it, so under a 15-minute policy a quarter-hour has to read
 * "3.25" and not "3.3".
 *
 * `exact` asks for the clock form — "41h 30m" — and only survives while
 * rounding is switched off. That form exists because a small overage is real
 * when time is recorded raw, and decimal hours would round it away into a
 * figure that reads as exactly on budget next to an Over badge. With a policy
 * in force there is no such overage to hide: every figure here is already a
 * whole number of intervals, so the clock form says nothing the decimal
 * doesn't and says it in a second format, in a card full of decimals.
 */
export function budgetDuration(budget, hoursField, secondsField, options = {}) {
    const { figure, unit } = budgetDurationParts(budget, hoursField, secondsField, options)
    return `${figure}${unit}`
}

/**
 * The same figure with the unit split off, so a caller can style the two
 * separately. The clock form carries its units inside the figure and has
 * nothing to split, which is why this returns the pair rather than assuming
 * there is always a trailing " hrs.".
 */
export function budgetDurationParts(
    budget,
    hoursField,
    secondsField,
    { exact = false, floorAtZero = false } = {}
) {
    let seconds = budget?.[secondsField]
    let value = budget?.[hoursField]
    if (floorAtZero && Number(seconds) <= 0) {
        seconds = 0
        value = 0
    }
    if (exact && seconds != null && !roundingPolicy()) {
        return { figure: hourMinuteDuration(seconds), unit: '' }
    }
    return { figure: policyHours(value), unit: ' hrs.' }
}

/** `budgetDuration` with the unit muted, for a headline figure in a stat card. */
export function budgetDurationHtml(budget, hoursField, secondsField, options = {}) {
    const { figure, unit } = budgetDurationParts(budget, hoursField, secondsField, options)
    return unit ? withHours(figure) : figure
}

/**
 * A figure with the unit trailing it, muted and unbolded.
 *
 * The house treatment for a headline number — the same one the budget rows and
 * TimeKeeper.formatTimeWithDifference use — so "40" in a stat card reads as
 * hours rather than a count, without the unit competing with the figure.
 */
export function withHours(value) {
    return `${value}<span class="font-normal text-faint"> hrs.</span>`
}

/** A percentage with no decimal — nothing here is precise enough to warrant one. */
export function percent(value) {
    return value == null ? '—' : `${Math.round(value)}%`
}

/** Escape for an HTML attribute. Exported because insight text is built in
 *  several modules and every one of them interpolates it into `data-insight`. */
export function escapeAttribute(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
}

/** "Aug 7" / "Aug 7, 2025" — the year only when it isn't the current one. */
export function shortDate(iso) {
    if (!iso) return '—'
    // Parsed as local rather than UTC: `new Date('2026-08-07')` is midnight UTC
    // and renders as the 6th anywhere west of Greenwich.
    const [y, m, d] = iso.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    const sameYear = y === new Date().getFullYear()
    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' }),
    })
}

export function dateRange(budget) {
    return `${shortDate(budget.start_date)} – ${shortDate(budget.end_date)}`
}

/**
 * The one-line headline: what this budget most needs you to know.
 *
 * Deliberately a single sentence rather than a row of figures. The stats grid
 * already has the numbers; what a glance needs is the interpretation, and the
 * interpretation is different in kind depending on the status — an over-budget
 * engagement needs a total, a live one needs a landing point, an upcoming one
 * needs a start date. A live budget that has not crossed a mature pace warning
 * leads with the hard remaining-hours figure instead of a volatile estimate.
 */
export function headline(budget) {
    if (budget.status === 'upcoming') {
        return `Starts ${shortDate(budget.start_date)} · ${policyHours(budget.budgeted_hours)} hrs. budgeted`
    }

    if (budget.status === 'over') {
        return `${budgetDuration(budget, 'over_by', 'over_by_seconds', { exact: true })} over budget`
    }

    // Deliberately says nothing about pace. A paused project has no pace, and
    // a projection built from a run rate nobody is running is exactly the
    // false comfort the hold feature exists to remove. What's useful instead
    // is what's left in the pot and when it starts moving again.
    if (budget.status === 'paused') {
        const since = budget.paused_since ? ` since ${shortDate(budget.paused_since)}` : ''
        const back = budget.resumes_on
            ? `resumes ${shortDate(budget.resumes_on)}`
            : 'no resume date set'
        return `On hold${since} · ${budgetDuration(budget, 'remaining_hours', 'remaining_seconds', { floorAtZero: true })} left · ${back}`
    }

    if (budget.status === 'closed') {
        const remainingSeconds = budget.remaining_seconds
        if (remainingSeconds != null) {
            return remainingSeconds >= 0
                ? `Finished ${budgetDuration(budget, 'remaining_hours', 'remaining_seconds')} under budget`
                // Routed through budgetDuration like every other overage, so a
                // closed budget can't be the one place that still says
                // "1h 30m over" while the card beside it says "1.5 hrs.".
                : `Finished ${budgetDuration(budget, 'over_by', 'over_by_seconds', { exact: true })} over budget`
        }
        const left = budget.remaining_hours
        return left >= 0
            ? `Finished ${policyHours(left)} hrs. under budget`
            : `Finished ${policyHours(-left)} hrs. over budget`
    }

    if (budget.status === 'at_risk') {
        return `Current average pace points to ${hours(budget.projected_hours)} hrs. — ${hours(budget.projected_overage)} over budget`
    }

    return `${budgetDuration(budget, 'remaining_hours', 'remaining_seconds', { floorAtZero: true })} remaining`
}

/**
 * Whether the elapsed-period tick means anything for this budget.
 *
 * The tick exists to be compared against the fill: *am I burning hours faster
 * than the calendar is burning days?* That comparison needs a period that is
 * still running. On an upcoming budget nothing has elapsed, and on a closed one
 * the answer is always "100%" — a full-width tick pinned to the end of every
 * closed bar, carrying no information and reading like a second fill.
 */
function hasLiveElapsed(budget) {
    return (
        budget.percent_elapsed != null
        && budget.status !== 'upcoming'
        && budget.status !== 'closed'
    )
}

/**
 * The meter: fill for hours used, hairline tick for how much of the period has
 * gone.
 *
 * Both are clamped to 100% of the track. An over-budget bar is drawn full and
 * hatched rather than allowed to overflow its container — the exact magnitude
 * of the overage is a number, and it's explained in the hover breakdown; what
 * the bar is for is being readable at a glance from across the room.
 *
 * This hover is the one place the *quantities* live — used, share, remaining,
 * elapsed. The status badge beside it explains the *judgement* and repeats none
 * of them, so hovering the two doesn't read the same four rows twice.
 */
export function meterBreakdown(budget, { showPeriodMarker = true } = {}) {
    const isOver = (budget.over_by_seconds ?? 0) > 0
    const hasRemaining =
        budget.remaining_seconds != null || budget.remaining_hours != null

    return insight(
        heading('Budget progress'),

        row(
            'Used',
            `${budgetDuration(budget, 'used_hours', 'used_seconds', { exact: isOver })}`
            + ` of ${policyHours(budget.budgeted_hours)} hrs.`
        ),
        row('Share used', percent(budget.percent_used_exact ?? budget.percent_used)),
        !hasRemaining
            ? ''
            : isOver
              ? row('Over budget',
                    budgetDuration(budget, 'over_by', 'over_by_seconds', { exact: true }))
              : row('Remaining',
                    budgetDuration(budget, 'remaining_hours', 'remaining_seconds',
                                   { floorAtZero: true })),
        !showPeriodMarker || !hasLiveElapsed(budget)
            ? ''
            : row('Period elapsed', percent(budget.percent_elapsed)),

        isOver ? note('The filled bar is capped at 100%.') : '',
        showPeriodMarker && budget.status === 'upcoming'
            ? note('The budget period has not started.')
            : '',
        showPeriodMarker
        && budget.status !== 'upcoming'
        && budget.status !== 'closed'
        && budget.percent_elapsed == null
            ? note('No elapsed-period marker is available.')
            : '',
    )
}

/**
 * The circled-i button that opens an insight popover.
 *
 * Shared so the Budgets page and the Today strip can't drift into different
 * markup. `body` may be a plain sentence or a structured document; the popover
 * lays the document out, while `aria-label` gets it flattened to prose, since a
 * screen reader announcing the separators would be worse than the paragraph
 * this replaced.
 */
export function insightIcon(body, label) {
    return `
      <button type="button" class="tk-insight" data-insight="${escapeAttribute(body)}"
              aria-label="${escapeAttribute(`${label}: ${insightToSentence(body)}`)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M12 11v5M12 8h.01"></path>
        </svg>
      </button>
    `
}

/**
 * The same circled-i, as a `<span>`, for use inside a link.
 *
 * The Today strip is one big anchor to the budget's detail view, and a
 * `<button>` inside an `<a>` is invalid — browsers unnest it, which puts the
 * icon outside the row it belongs to and makes it unreachable. A span carries
 * the identical `data-insight` contract without nesting interactive content;
 * `tabindex` puts it back on the keyboard path the button gave for free, and
 * base.js already calls `preventDefault`/`stopPropagation` on `.tk-insight`
 * clicks, so opening the popover doesn't also follow the link.
 *
 * Markup below the class is deliberately identical to `insightIcon` — the two
 * must look like one control, so they share a stylesheet rule and differ only
 * in the tag they can legally use.
 */
export function insightIconInline(body, label) {
    return `
      <span class="tk-insight" tabindex="0" data-insight="${escapeAttribute(body)}"
            aria-label="${escapeAttribute(`${label}: ${insightToSentence(body)}`)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M12 11v5M12 8h.01"></path>
        </svg>
      </span>
    `
}

/**
 * Why the badge says what it says.
 *
 * Written once and used by both the Budgets page and the Today strip, because
 * the two disagreeing about why something is at risk is exactly the kind of
 * small wrongness that makes people stop trusting the colour.
 *
 * Deliberately **not** a second copy of the meter's breakdown. Both hovers used
 * to open with Used / Share used / Remaining / Period elapsed, so the badge's
 * one job — explaining a judgement — was buried under four figures the bar
 * beside it already gives on hover, and the reason the colour had been chosen
 * arrived fifth. Quantities belong to the meter; this answers only *why this
 * colour*, in the fewest rows that can carry the answer.
 *
 * The one figure it does restate is the overage, because for an over budget the
 * magnitude *is* the reason.
 *
 * Only the three states that are a judgement get one. Upcoming, On hold and
 * Closed are statements of fact the badge already makes in full.
 */
export function statusInsight(budget) {
    const threshold = budget.risk_threshold_percent == null
        ? ''
        : row('Flags above', `${hours(budget.risk_threshold_percent)}% over budget`)
    const projection = budget.projected_hours == null ? [] : [
        row('Pace implies', `${hours(budget.projected_hours)} hrs. total`),
        row('Share of commitment', percent(budget.projected_percent)),
    ]
    // Said wherever a projection is shown: a number built on three days of
    // history looks exactly like one built on thirty.
    const immature = budget.projected_hours != null && !budget.projection_mature
        ? note(MATURITY_RULE)
        : ''

    if (budget.status === 'over') {
        return insight(
            heading('Over budget'),
            row('Over by',
                budgetDuration(budget, 'over_by', 'over_by_seconds', { exact: true })),
            note('Recorded time has passed the commitment. This is spent, not projected.'),
        )
    }

    if (budget.status === 'at_risk') {
        return insight(
            heading('At risk'),
            ...projection,
            budget.projected_overage == null
                ? ''
                : row('Over commitment by', `${hours(budget.projected_overage)} hrs.`),
            threshold,
            note('Flagged on pace, not spend — carry on at this rate and the budget '
                 + 'ends over. Nothing is overspent yet.'),
            immature,
        )
    }

    if (budget.status === 'on_track') {
        return insight(
            heading('Within budget'),
            ...projection,
            threshold,
            note(projection.length
                ? 'Not flagged: the projected total stays under the threshold.'
                : 'Not flagged: recorded time is within the commitment.'),
            immature,
        )
    }

    return null
}

export function meter(budget, { large = false, showPeriodMarker = true } = {}) {
    const exactPercent = budget.percent_used_exact ?? budget.percent_used ?? 0
    const used = Math.min(100, Math.max(0, exactPercent))
    const elapsed = budget.percent_elapsed
    const over = (budget.over_by_seconds ?? 0) > 0 || exactPercent > 100
    const breakdown = meterBreakdown(budget, { showPeriodMarker })

    const marker =
        !showPeriodMarker || !hasLiveElapsed(budget)
            ? ''
            : `<span class="tk-meter-marker" style="left: ${Math.min(100, elapsed)}%"></span>`

    return `<div class="tk-meter tk-meter-tooltip${large ? ' tk-meter-lg' : ''}"
                 data-insight="${escapeAttribute(breakdown)}" role="img" tabindex="0"
                 aria-label="${escapeAttribute(insightToSentence(breakdown))}" title="">`
        + `<div class="tk-meter-fill${over ? ' tk-meter-overflow' : ''}" style="width: ${used}%"></div>`
        + marker
        + '</div>'
}

/**
 * Pace sentence for the stats row, or null when there's nothing useful to say.
 *
 * Suppressed rather than shown as "—" when the budget has no working days left:
 * "you need to average 4 hrs/day" over zero remaining days is not advice.
 */
export function paceNote(budget) {
    if (budget.status === 'upcoming' || budget.status === 'closed') return null
    // Same reason the paused headline omits the projection: "you need 4
    // hrs/day" is advice about a period nobody is working. The held-days count
    // is the honest thing to say instead, and the card says it.
    if (budget.status === 'paused') return null
    if (budget.required_hours_per_day == null) return null

    if (budget.required_hours_per_day < 0) {
        // Away from zero: an overage snapped down reads as a smaller problem
        // than it is.
        return `${policyHours(-budget.required_hours_per_day, { direction: 'up' })} hrs/day over for the rest`
    }
    // Down, because this is an allowance. Snapped up, it would quietly
    // authorise a quarter of an hour a day the budget doesn't hold.
    return `${policyHours(budget.required_hours_per_day, { direction: 'down' })} hrs/day left to stay on budget`
}
