/**
 * Shared budget rendering.
 *
 * The Budgets page and the Today-page widget show the same numbers at two
 * sizes, and the one thing that must never happen is the dashboard saying a
 * budget is fine while the Budgets page says it isn't. Every formatter and the
 * meter itself live here so there's exactly one implementation of "what does
 * 34.5 hours against 40 look like".
 */

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

/** A percentage with no decimal — nothing here is precise enough to warrant one. */
export function percent(value) {
    return value == null ? '—' : `${Math.round(value)}%`
}

function escapeAttribute(value) {
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
        return `Starts ${shortDate(budget.start_date)} · ${hours(budget.budgeted_hours)} hrs. budgeted`
    }

    if (budget.status === 'over') {
        return `${hours(budget.over_by)} hrs. over budget`
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
        return `On hold${since} · ${hours(budget.remaining_hours)} hrs. left · ${back}`
    }

    if (budget.status === 'closed') {
        const left = budget.remaining_hours
        return left >= 0
            ? `Finished ${hours(left)} hrs. under budget`
            : `Finished ${hours(-left)} hrs. over budget`
    }

    if (budget.status === 'at_risk') {
        return `Current average pace points to ${hours(budget.projected_hours)} hrs. — ${hours(budget.projected_overage)} over budget`
    }

    return `${hours(budget.remaining_hours)} hrs. remaining`
}

/**
 * The meter: fill for hours used, hairline tick for how much of the period has
 * gone.
 *
 * Both are clamped to 100% of the track. An over-budget bar is drawn full and
 * hatched rather than allowed to overflow its container — the exact magnitude
 * of the overage is a number, and it's explained in the hover breakdown; what
 * the bar is for is being readable at a glance from across the room.
 */
export function meterBreakdown(budget, { showPeriodMarker = true } = {}) {
    const usage = `Used: ${hours(budget.used_hours)} of ${hours(budget.budgeted_hours)} hrs. (${percent(budget.percent_used)}).`
    const remaining =
        budget.remaining_hours == null
            ? ''
            : budget.remaining_hours < 0
              ? ` Over budget: ${hours(-budget.remaining_hours)} hrs.`
              : ` Remaining: ${hours(budget.remaining_hours)} hrs.`
    const capped = (budget.percent_used ?? 0) > 100
        ? ' The filled bar is capped at 100%.'
        : ''
    const elapsed = !showPeriodMarker
        ? ''
        : budget.status === 'upcoming'
            ? ' The budget period has not started.'
            : budget.percent_elapsed == null
              ? ' No elapsed-period marker is available.'
              : ` Period marker: ${percent(budget.percent_elapsed)} elapsed.`

    return usage + remaining + capped + elapsed
}

export function meter(budget, { large = false, showPeriodMarker = true } = {}) {
    const used = Math.min(100, Math.max(0, budget.percent_used ?? 0))
    const elapsed = budget.percent_elapsed
    const over = (budget.percent_used ?? 0) > 100
    const breakdown = meterBreakdown(budget, { showPeriodMarker })

    const marker =
        !showPeriodMarker || elapsed == null || budget.status === 'upcoming'
            ? ''
            : `<span class="tk-meter-marker" style="left: ${Math.min(100, elapsed)}%"></span>`

    return `<div class="tk-meter tk-meter-tooltip${large ? ' tk-meter-lg' : ''}"
                 data-insight="${escapeAttribute(breakdown)}" role="img"
                 aria-label="${escapeAttribute(`Budget progress. ${breakdown}`)}" title="">`
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
        return `${hours(-budget.required_hours_per_day)} hrs/day over for the rest`
    }
    return `${hours(budget.required_hours_per_day)} hrs/day left to stay on budget`
}
