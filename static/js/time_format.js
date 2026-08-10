/**
 * Clock-time parsing, serialization, and display preferences.
 *
 * A clock time is deliberately not a Date. Parsing through Date would attach
 * an arbitrary day and timezone, making a simple value such as 09:30 capable
 * of shifting as it crosses APIs. Everything here operates on numeric clock
 * fields only.
 */

export const TIME_FORMAT_12H = '12h'
export const TIME_FORMAT_24H = '24h'
export const TIME_FORMATS = Object.freeze([TIME_FORMAT_12H, TIME_FORMAT_24H])

const root = document.documentElement
const CANONICAL_CLOCK_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/
const LEGACY_12_HOUR_RE = /^(\d{1,2}):(\d{2})\s+(AM|PM)$/i

function validClockFields(hours, minutes, seconds = 0) {
    return (
        Number.isInteger(hours) &&
        Number.isInteger(minutes) &&
        Number.isInteger(seconds) &&
        hours >= 0 &&
        hours <= 23 &&
        minutes >= 0 &&
        minutes <= 59 &&
        seconds >= 0 &&
        seconds <= 59
    )
}

/**
 * Parse only the clock formats exchanged by Time Keeper.
 *
 * Accepted strings are canonical HH:MM / HH:MM:SS and the legacy
 * h:mm AM/PM display value. The returned object is detached from Date and is
 * safe to use for formatting or minute arithmetic. Invalid input returns null.
 */
export function parseClockTime(value) {
    if (typeof value !== 'string') return null
    const input = value.trim()

    const canonical = CANONICAL_CLOCK_RE.exec(input)
    if (canonical) {
        const hours = Number(canonical[1])
        const minutes = Number(canonical[2])
        const seconds = canonical[3] === undefined ? 0 : Number(canonical[3])
        if (!validClockFields(hours, minutes, seconds)) return null
        return { hours, minutes, seconds, hasSeconds: canonical[3] !== undefined }
    }

    const legacy = LEGACY_12_HOUR_RE.exec(input)
    if (!legacy) return null

    const hour12 = Number(legacy[1])
    const minutes = Number(legacy[2])
    if (hour12 < 1 || hour12 > 12 || minutes < 0 || minutes > 59) return null

    const meridiem = legacy[3].toUpperCase()
    const hours = (hour12 % 12) + (meridiem === 'PM' ? 12 : 0)
    return { hours, minutes, seconds: 0, hasSeconds: false }
}

function requireClockTime(value) {
    if (
        value &&
        typeof value === 'object' &&
        validClockFields(value.hours, value.minutes, value.seconds ?? 0)
    ) {
        return {
            hours: value.hours,
            minutes: value.minutes,
            seconds: value.seconds ?? 0,
            hasSeconds: Boolean(value.hasSeconds),
        }
    }

    const parsed = parseClockTime(value)
    if (parsed) return parsed
    throw new TypeError(`Invalid clock time: ${String(value)}`)
}

/** Return seconds since local midnight for comparison and duration arithmetic. */
export function clockTimeToSeconds(value) {
    const clock = requireClockTime(value)
    return clock.hours * 3600 + clock.minutes * 60 + clock.seconds
}

/** Build a local Date carrying this clock value, without parsing a date string. */
export function clockTimeToDate(value, baseDate = new Date()) {
    const clock = requireClockTime(value)
    const result = new Date(baseDate)
    result.setHours(clock.hours, clock.minutes, clock.seconds, 0)
    return result
}

/** Canonical clock value for the current local time. */
export function currentClockTime({ includeSeconds = false } = {}) {
    const now = new Date()
    return serializeClockTime(
        { hours: now.getHours(), minutes: now.getMinutes(), seconds: now.getSeconds() },
        { includeSeconds }
    )
}

function twoDigits(value) {
    return String(value).padStart(2, '0')
}

/** Serialize a clock value for APIs as HH:MM (or HH:MM:SS when requested). */
export function serializeClockTime(value, { includeSeconds = false } = {}) {
    const clock = requireClockTime(value)
    const canonical = `${twoDigits(clock.hours)}:${twoDigits(clock.minutes)}`
    return includeSeconds ? `${canonical}:${twoDigits(clock.seconds)}` : canonical
}

/** Format a clock value for display using the explicit or current preference. */
export function formatClockTime(value, timeFormat = currentTimeFormat(), options = {}) {
    const clock = requireClockTime(value)
    const includeSeconds = Boolean(options.includeSeconds)
    const suffix = includeSeconds ? `:${twoDigits(clock.seconds)}` : ''

    if (timeFormat === TIME_FORMAT_24H) {
        return `${twoDigits(clock.hours)}:${twoDigits(clock.minutes)}${suffix}`
    }
    if (timeFormat !== TIME_FORMAT_12H) {
        throw new TypeError(`Invalid time format: ${String(timeFormat)}`)
    }

    const hour12 = clock.hours % 12 || 12
    const meridiem = clock.hours >= 12 ? 'PM' : 'AM'
    return `${hour12}:${twoDigits(clock.minutes)}${suffix} ${meridiem}`
}

/** The server-rendered preference currently applied to this document. */
export function currentTimeFormat() {
    const value = root.dataset.timeFormat
    return TIME_FORMATS.includes(value) ? value : TIME_FORMAT_12H
}

/**
 * Apply a display preference and announce it to controls that need rerendering.
 * Persistence is intentionally the caller's responsibility.
 */
export function applyTimeFormat(timeFormat) {
    if (!TIME_FORMATS.includes(timeFormat)) {
        throw new TypeError(`Invalid time format: ${String(timeFormat)}`)
    }

    const changed = currentTimeFormat() !== timeFormat
    root.dataset.timeFormat = timeFormat
    if (changed) {
        document.dispatchEvent(
            new CustomEvent('timeFormatChanged', { detail: { timeFormat } })
        )
    }
    return timeFormat
}

/** Flatpickr tokens matching a preference, useful when updating an instance. */
export function flatpickrTimeFormat(timeFormat = currentTimeFormat()) {
    if (!TIME_FORMATS.includes(timeFormat)) {
        throw new TypeError(`Invalid time format: ${String(timeFormat)}`)
    }
    return {
        dateFormat: timeFormat === TIME_FORMAT_24H ? 'H:i' : 'h:i K',
        time_24hr: timeFormat === TIME_FORMAT_24H,
    }
}

/** Complete baseline options for constructing a clock-only Flatpickr. */
export function flatpickrTimeOptions(overrides = {}, timeFormat = currentTimeFormat()) {
    return {
        enableTime: true,
        noCalendar: true,
        ...flatpickrTimeFormat(timeFormat),
        ...overrides,
    }
}

/** vis-timeline label tokens matching the selected clock convention. */
export function visTimelineTimeFormat(timeFormat = currentTimeFormat()) {
    if (!TIME_FORMATS.includes(timeFormat)) {
        throw new TypeError(`Invalid time format: ${String(timeFormat)}`)
    }

    const twelveHour = timeFormat === TIME_FORMAT_12H
    return {
        minorLabels: {
            millisecond: 'SSS',
            second: 's',
            minute: twelveHour ? 'h:mm A' : 'HH:mm',
            hour: twelveHour ? 'h A' : 'HH:mm',
            weekday: 'ddd D',
            day: 'D',
            week: 'w',
            month: 'MMM',
            year: 'YYYY',
        },
        majorLabels: {
            millisecond: twelveHour ? 'h:mm:ss A' : 'HH:mm:ss',
            second: twelveHour ? 'D MMMM h:mm A' : 'D MMMM HH:mm',
            minute: 'ddd D MMMM',
            hour: 'ddd D MMMM',
            weekday: 'MMMM YYYY',
            day: 'MMMM YYYY',
            week: 'MMMM YYYY',
            month: 'YYYY',
            year: '',
        },
    }
}
