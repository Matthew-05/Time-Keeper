/**
 * Local-midnight date arithmetic for the app's month grids.
 *
 * Two calendars now share this: the work calendar in Settings, and the Summary
 * dashboard's grid. They had identical private copies of every helper below,
 * which is exactly the arrangement where one of them quietly acquires a fix the
 * other doesn't.
 *
 * Everything here is deliberately local-time and string-keyed:
 *
 * - `new Date('2026-08-11')` parses as **UTC midnight**, so west of Greenwich it
 *   renders as the 10th. `localDate()` splits the string and builds a local date
 *   instead, which is the only reason a grid shows the right dates at all.
 * - Dates travel as `YYYY-MM-DD` strings, not `Date` objects. That format sorts
 *   and compares lexicographically, so range checks are plain `<` / `>` on
 *   strings, and it's already what the API speaks.
 *
 * Weekday numbers stay ISO (Monday is 0) throughout; `week_start` only decides
 * which column a grid begins on. See `week_start.js`.
 */

import { daysSinceWeekStart } from './week_start.js'

export const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
})
export const RANGE_FORMAT = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
})
/** Indexed by ISO weekday, so `WEEKDAY_NAMES[0]` is Monday. */
export const WEEKDAY_NAMES = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
]

/** `YYYY-MM-DD` as a date at local midnight. */
export function localDate(value) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
}

/** A date as `YYYY-MM-DD`, in local time rather than UTC. */
export function isoDate(value) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

export function addDays(value, amount) {
    const next = new Date(value.getFullYear(), value.getMonth(), value.getDate())
    next.setDate(next.getDate() + amount)
    return next
}

/** The 1st of the month containing `value`. */
export function startOfMonth(value) {
    return new Date(value.getFullYear(), value.getMonth(), 1)
}

/** The last day of the month containing `value`. */
export function endOfMonth(value) {
    return new Date(value.getFullYear(), value.getMonth() + 1, 0)
}

/* A grid always renders whole weeks, so it runs from the start of the week
   containing the 1st to the end of the week containing the last day. Which
   weekday that is depends on the week-start preference; the weekday *numbers*
   used everywhere else remain ISO. */
export function startOfCalendar(month) {
    const first = startOfMonth(month)
    return addDays(first, -daysSinceWeekStart(first))
}

export function endOfCalendar(month) {
    const last = endOfMonth(month)
    return addDays(last, 6 - daysSinceWeekStart(last))
}

/** One ISO date, or two, as the reader would say it. */
export function formatRange(start, end) {
    if (!end || start === end) return RANGE_FORMAT.format(localDate(start))
    return `${RANGE_FORMAT.format(localDate(start))} – ${RANGE_FORMAT.format(localDate(end))}`
}

/**
 * `formatRange`, but a span that is exactly one calendar month names the month.
 *
 * "August 2026" reads better than both endpoints where a selection covers a
 * whole month — which is what clicking a weekday heading always produces.
 */
export function formatSpan(start, end) {
    const from = localDate(start)
    const to = localDate(end || start)
    const wholeMonth =
        from.getDate() === 1
        && to.getDate() === endOfMonth(to).getDate()
        && from.getFullYear() === to.getFullYear()
        && from.getMonth() === to.getMonth()
    return wholeMonth ? MONTH_FORMAT.format(from) : formatRange(start, end || start)
}
