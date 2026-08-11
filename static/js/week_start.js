/**
 * Which day a calendar grid begins on.
 *
 * This preference is presentational and nothing else. Weekday *numbers* are ISO
 * everywhere they are stored, sent or compared — Monday is 0, Sunday is 6 — and
 * that is deliberately not negotiable: `work_days`, the override rules and the
 * capacity maths in `budgets.py` all share that indexing, so a display choice
 * must never reach them. What changes here is column order, and which day a
 * calendar's first row starts on.
 *
 * Two numbering systems meet in this file, which is the only genuinely
 * confusing part:
 *
 * - **ISO weekday** (0 = Monday … 6 = Sunday) — ours, and what every caller
 *   passes and receives.
 * - **`Date.prototype.getDay`** (0 = Sunday … 6 = Saturday) — the platform's,
 *   and also what flatpickr's `firstDayOfWeek` expects.
 *
 * Conversion is confined to `isoWeekday` and `WEEK_START_DAYS` so no caller has
 * to think about it.
 */

export const WEEK_START_SUNDAY = 'sunday'
export const WEEK_START_MONDAY = 'monday'
export const WEEK_STARTS = Object.freeze([WEEK_START_SUNDAY, WEEK_START_MONDAY])

/** ISO weekday number (Monday is 0) for a Date. */
export function isoWeekday(value) {
    return (value.getDay() + 6) % 7
}

// The starting weekday of each preference, in *both* numbering systems.
const WEEK_START_DAYS = Object.freeze({
    [WEEK_START_SUNDAY]: { iso: 6, getDay: 0 },
    [WEEK_START_MONDAY]: { iso: 0, getDay: 1 },
})

const root = document.documentElement

function requireWeekStart(weekStart) {
    if (!WEEK_STARTS.includes(weekStart)) {
        throw new TypeError(`Invalid week start: ${String(weekStart)}`)
    }
    return weekStart
}

/** The server-rendered preference currently applied to this document. */
export function currentWeekStart() {
    const value = root.dataset.weekStart
    return WEEK_STARTS.includes(value) ? value : WEEK_START_SUNDAY
}

/**
 * Apply a preference to this document, announcing it as `weekStartChanged`.
 * Persistence is intentionally the caller's responsibility.
 *
 * Unlike the theme or the clock format, nothing on a page redraws in response:
 * calendars read the preference once, when they are built. That is enough
 * because the only control that changes it lives on the settings page, which
 * has no calendar on it. What this *does* buy is a truthful `currentWeekStart()`
 * while the settings draft is being edited, so the control can compare against
 * it and roll back cleanly if the write fails.
 */
export function applyWeekStart(weekStart) {
    requireWeekStart(weekStart)

    const changed = currentWeekStart() !== weekStart
    root.dataset.weekStart = weekStart
    if (changed) {
        document.dispatchEvent(
            new CustomEvent('weekStartChanged', { detail: { weekStart } })
        )
    }
    return weekStart
}

/**
 * How many days back from `value` the containing week began.
 *
 * Useful for snapping a month's first date back to the start of its calendar
 * row, and its last date forward to the end of one.
 */
export function daysSinceWeekStart(value, weekStart = currentWeekStart()) {
    const first = WEEK_START_DAYS[requireWeekStart(weekStart)].getDay
    return (value.getDay() - first + 7) % 7
}

/** Flatpickr's own numbering, for `locale.firstDayOfWeek`. */
export function flatpickrFirstDayOfWeek(weekStart = currentWeekStart()) {
    return WEEK_START_DAYS[requireWeekStart(weekStart)].getDay
}

/**
 * Baseline options for constructing any Flatpickr that shows a calendar.
 *
 * Spread the call site's own options through this so they can still override
 * anything they need to. Clock-only pickers (`noCalendar: true`) have no week
 * to start and don't need it.
 *
 * This has to be applied at construction: flatpickr copies its locale into
 * `instance.l10n` once during setup, and `set('locale', …)` afterwards updates
 * the config without rebuilding either `l10n` or the weekday header row. Since
 * the preference can only be changed from the settings page, and no picker
 * exists there, construction time is the only moment that matters.
 */
export function flatpickrCalendarOptions(overrides = {}, weekStart = currentWeekStart()) {
    return {
        locale: { firstDayOfWeek: flatpickrFirstDayOfWeek(weekStart) },
        ...overrides,
    }
}
