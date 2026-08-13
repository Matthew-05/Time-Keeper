/**
 * The Summary dashboard's month grid.
 *
 * Same gestures and the same stylesheet as the work calendar in Settings —
 * click a date, Shift-click a second for a range, click a weekday heading for
 * every matching day — but it reads rather than writes: each cell shows what
 * was billable that day, and the selection is what the whole dashboard below is
 * reporting on. Learning the grid once is meant to be enough for both pages.
 *
 * Three deliberate differences from the Settings calendar:
 *
 * - **The Shift anchor survives month navigation.** Selecting a range that
 *   crosses a month boundary is ordinary here (a quarter, the last six weeks),
 *   and clearing the anchor on every page turn would make it impossible.
 * - **A weekday selection follows you to the new month** instead of being
 *   dropped. "Mondays" is the question being asked; which month it's asked
 *   about is the thing the arrows change.
 * - **`selectionEnd` is always set.** Settings distinguishes a one-day pick
 *   from a range; every consumer here wants a start/end pair, so a single day
 *   is a range of one and there is no null case to handle downstream.
 * - **Nothing from today onwards can be selected.** There is nothing to report
 *   on a day that hasn't happened, and today hasn't finished happening — its
 *   total moves while you look at it. `lastComplete` (yesterday) is the hard
 *   right-hand edge, and every range arriving here — a click, a Shift-drag, a
 *   weekday heading, a preset chip — goes through `clampRange()`. Today and
 *   the days after it are still *drawn*, greyed and disabled, and today still
 *   gets its ring: a calendar that stopped painting the rest of the month
 *   would read as broken, and where you are in it is worth knowing.
 *
 * Amount formatting is injected rather than decided here, so the cells, the
 * KPI strip and the charts can't disagree about what a figure looks like.
 */

import { clientColor } from './base.js'
import { isoWeekday } from './week_start.js'
import {
    MONTH_FORMAT,
    RANGE_FORMAT,
    WEEKDAY_NAMES,
    addDays,
    endOfCalendar,
    endOfMonth,
    formatRange,
    formatSpan,
    isoDate,
    localDate,
    startOfCalendar,
    startOfMonth,
} from './calendar_dates.js'

/* Beyond three the dots stop being countable at a glance and start being
   texture, so the rest become a "+2". */
const MAX_DOTS = 3

export class SummaryCalendar {
    /**
     * @param {object} options
     * @param {(start: string, end: string) => Promise<object>} options.fetchWindow
     *        Loads `/api/summary/calendar` for one grid window.
     * @param {(selection: object) => void} options.onChange
     *        Called whenever the selected range changes, never on a plain
     *        month change — paging is navigation, not a new question.
     * @param {(row: object) => string} options.formatAmount
     *        Renders one day's billable figure for a cell.
     */
    constructor({ fetchWindow, onChange, formatAmount }) {
        this.fetchWindow = fetchWindow
        this.onChange = onChange
        this.formatAmount = formatAmount

        const now = new Date()
        this.month = startOfMonth(now)
        this.today = isoDate(now)
        /* The right-hand edge of every selection, and it is *yesterday*.
           Today's total is still moving — a task is probably running as you
           read it — so a figure that includes it describes a day that hasn't
           finished, and reloading the page changes it. The grid still marks
           today, because where you are in the month is worth knowing; it just
           isn't a day you can report on yet. */
        this.lastComplete = isoDate(addDays(now, -1))
        this.days = new Map()
        // What a full heat bar means. Never the window's own peak alone — see
        // renderScale().
        this.scale = 1
        this.loadIntent = 0
        this.retryTimer = null

        this.selectionStart = null
        this.selectionEnd = null
        this.selectionWeekdays = null
        this.rangeAnchor = null

        this.grid = document.getElementById('summary-calendar-grid')
        this.weekdayHeaders = document.getElementById('summary-calendar-weekdays')
        this.monthTitle = document.getElementById('summary-calendar-month')
        this.monthTotal = document.getElementById('summary-calendar-month-total')
    }

    /**
     * First paint: adopt a selection and load the month containing it.
     *
     * Separate from `setRange` because it must *not* emit — the dashboard
     * already knows the range it just handed over, and a change event here
     * would make it fetch the same thing twice on every page load.
     */
    start({ start, end, weekdays = null }) {
        const range = this.clampRange(start, end) ?? [this.lastComplete, this.lastComplete]
        this.selectionStart = range[0]
        this.selectionEnd = range[1]
        this.selectionWeekdays = weekdays
        this.rangeAnchor = weekdays === null ? range[0] : null
        this.month = this.focusMonth(range[0], range[1])
        this.bindEvents()
        return this.load()
    }

    /**
     * A range trimmed to the part that has happened, or null if none of it has.
     *
     * The single choke point for the no-future-dates rule: clicks, Shift-drags,
     * weekday headings and preset chips all pass through it, so there is one
     * place to read rather than four places to keep in step. Null means "this
     * gesture selects nothing" — a weekday heading clicked in next month — and
     * every caller treats it as a no-op rather than inventing a fallback.
     */
    clampRange(start, end) {
        if (start > this.lastComplete) return null
        return [start, end > this.lastComplete ? this.lastComplete : end]
    }

    /**
     * Which month to put on screen for a range.
     *
     * The month holding the most recent day worth reporting on, whenever the
     * range reaches it, and the range's last month otherwise. Anchored on
     * `lastComplete` rather than today so that on the 1st of a month "last 30
     * days" opens on the month the time is actually in, instead of on a page
     * with a single greyed cell.
     */
    focusMonth(start, end) {
        const covered = start <= this.lastComplete && this.lastComplete <= end
        return startOfMonth(localDate(covered ? this.lastComplete : end))
    }

    bindEvents() {
        document.getElementById('summary-calendar-previous')
            .addEventListener('click', () => this.changeMonth(-1))
        document.getElementById('summary-calendar-next')
            .addEventListener('click', () => this.changeMonth(1))
        document.getElementById('summary-calendar-today')
            .addEventListener('click', () => this.showMonthOf(new Date()))

        this.weekdayHeaders.addEventListener('click', (event) => {
            const button = event.target.closest('[data-calendar-weekday]')
            if (button) this.selectWeekday(Number(button.dataset.calendarWeekday))
        })

        /* Delegated rather than a listener per cell: the grid is rebuilt on
           every selection change, and 42 listeners re-bound each time is 42
           chances to leak one. */
        this.grid.addEventListener('click', (event) => {
            const cell = event.target.closest('[data-date]')
            if (cell) this.selectDate(cell.dataset.date, event.shiftKey)
        })
    }

    /* ---- Data ---- */

    async load() {
        clearTimeout(this.retryTimer)
        const start = startOfCalendar(this.month)
        const end = endOfCalendar(this.month)
        const intent = ++this.loadIntent
        this.monthTitle.textContent = MONTH_FORMAT.format(this.month)

        try {
            const payload = await this.fetchWindow(isoDate(start), isoDate(end))
            // A slow window losing to a faster one the user has already paged
            // to. Dropping it is the whole point of the intent counter.
            if (intent !== this.loadIntent) return

            this.days = new Map(payload.days.map((day) => [day.date, day]))
            this.renderScale(payload.days)
            this.renderMonthTotal()
            this.render()
        } catch {
            if (intent !== this.loadIntent) return
            // fetchFromAPI has already spent about a minute retrying, so this
            // is a real outage rather than a blip. Say so and keep trying —
            // there's nothing for the user to usefully click.
            this.grid.replaceChildren()
            this.grid.innerHTML =
                '<div class="tk-empty col-span-7 py-12">Can\'t reach the server. Reconnecting…</div>'
            this.retryTimer = setTimeout(() => this.load(), 3000)
        }
    }

    /**
     * What a full heat bar is worth.
     *
     * Scaling to the window's own peak would be a lie on a quiet month: a week
     * of one-hour days would draw a full bar on its best day and read as a
     * blowout. Taking the larger of the peak and the biggest day of *capacity*
     * in view means a full bar always means "a full working day or more", and
     * a light month honestly looks light.
     */
    renderScale(days) {
        this.scale = days.reduce(
            (largest, day) => Math.max(largest, day.billable_hours, day.capacity_hours),
            1,
        )
    }

    /* ---- Rendering ---- */

    render() {
        this.renderWeekdayHeaders()
        const cells = document.createDocumentFragment()
        const end = endOfCalendar(this.month)
        for (let day = startOfCalendar(this.month); day <= end; day = addDays(day, 1)) {
            cells.appendChild(this.renderDay(day))
        }
        this.grid.replaceChildren(cells)
    }

    renderDay(day) {
        const key = isoDate(day)
        const row = this.days.get(key)
        const billable = row?.billable_hours ?? 0
        const selected = this.isSelected(key)
        const future = key > this.lastComplete

        const cell = document.createElement('button')
        cell.type = 'button'
        // Disabled rather than merely ignored on click, so the cursor, the
        // hover and the tab order all say the same thing the rule does.
        cell.disabled = future
        cell.className = 'tk-work-calendar-day tk-summary-day'
        cell.classList.toggle('is-future', future)
        cell.classList.toggle('is-outside', day.getMonth() !== this.month.getMonth())
        /* No `is-off`: the summary grid doesn't shade working days differently
           from non-working ones. Settings' calendar is where that distinction
           is the subject; here it was a third fill under an amount, three dots
           and a heat bar, and a day you didn't work already reads as empty.
           Capacity hasn't gone anywhere — `is-over` below is still measured
           against it, which is what turns a weekend hour amber. The aria-label
           still says so, because a fill isn't available to a screen reader and
           it costs nothing there. */
        cell.classList.toggle('is-selected', selected)
        cell.classList.toggle('is-today', key === this.today)
        // Over capacity gets its own bar colour rather than a clipped bar —
        // "this day ran long" is the signal, and a bar pinned at 100% hides it.
        cell.classList.toggle('is-over', Boolean(row) && billable > row.capacity_hours)
        cell.dataset.date = key
        cell.setAttribute('role', 'gridcell')
        cell.setAttribute('aria-pressed', selected ? 'true' : 'false')
        cell.setAttribute('aria-label', this.describeDay(day, row))

        const top = document.createElement('span')
        top.className = 'tk-summary-day-top'
        const number = document.createElement('span')
        number.className = 'tk-calendar-date-number'
        number.textContent = String(day.getDate())
        top.appendChild(number)

        /* A day you can't report on is a date and nothing else. A future one
           has no amount, no clients and a heat bar that could only ever read
           zero; today has all three, but they are a running total that would
           be stale a minute later — and printing one beside figures that
           deliberately exclude it is worse than printing nothing. Drawing an
           em dash over an empty track on every remaining cell of the month was
           most of what made the grid noisy either way. Keeping the cell rather
           than blanking the row is what holds the month's shape. */
        if (future) {
            cell.appendChild(top)
            return cell
        }

        top.appendChild(this.renderDots(row))

        const amountRow = document.createElement('span')
        amountRow.className = 'tk-calendar-capacity-row'
        const amount = document.createElement('span')
        amount.className = 'tk-calendar-capacity tabular'
        amount.classList.toggle('tk-summary-day-empty', billable <= 0)
        amount.textContent = billable > 0 ? this.formatAmount(row) : '—'
        amountRow.appendChild(amount)

        const heat = document.createElement('span')
        heat.className = 'tk-summary-day-heat'
        const fill = document.createElement('span')
        fill.style.width = `${Math.min(100, (billable / this.scale) * 100)}%`
        heat.appendChild(fill)

        cell.append(top, amountRow, heat)
        return cell
    }

    renderDots(row) {
        const dots = document.createElement('span')
        dots.className = 'tk-summary-day-dots'
        const clients = (row?.clients ?? []).filter(
            (client) => client.billable_hours > 0 || client.tracked_hours > 0,
        )

        clients.slice(0, MAX_DOTS).forEach((client) => {
            const dot = document.createElement('span')
            dot.className = 'tk-summary-day-dot'
            // Same stored colour the charts and History use, so a client is
            // one colour everywhere in the app.
            dot.style.backgroundColor = clientColor(client.client_name, client.client_color)
            dot.title = client.client_name
            dots.appendChild(dot)
        })

        if (clients.length > MAX_DOTS) {
            const more = document.createElement('span')
            more.className = 'tk-summary-day-more tabular'
            more.textContent = `+${clients.length - MAX_DOTS}`
            dots.appendChild(more)
        }
        return dots
    }

    renderWeekdayHeaders() {
        // A month that hasn't started has no selectable weekday in it.
        const unreachable = isoDate(startOfMonth(this.month)) > this.lastComplete
        this.weekdayHeaders.querySelectorAll('[data-calendar-weekday]').forEach((button) => {
            const selected = this.selectionWeekdays?.includes(
                Number(button.dataset.calendarWeekday),
            ) || false
            button.disabled = unreachable
            button.classList.toggle('active', selected)
            button.setAttribute('aria-pressed', selected ? 'true' : 'false')
        })
    }

    renderMonthTotal() {
        const inMonth = [...this.days.values()].filter((day) => {
            const value = localDate(day.date)
            return value.getMonth() === this.month.getMonth()
                && value.getFullYear() === this.month.getFullYear()
        })
        const elapsed = inMonth.filter((day) => day.date <= this.lastComplete)
        if (!elapsed.length) {
            this.monthTotal.textContent = 'Not started yet'
            return
        }

        const billable = elapsed.reduce((total, day) => total + day.billable_hours, 0)
        /* Every working day the calendar defines, not just the ones with time
           on them: the figure beside it is what the month is *worth*, and a
           denominator that shrank each time you failed to log a day would make
           a bad month read as a normal one.

           Elapsed ones only, today included — the same cut the dashboard's
           figures take. A total for the month so far divided by a month's worth
           of working days would describe a shortfall that hasn't happened yet,
           and on the 1st it would read as a catastrophe. */
        const working = elapsed.filter((day) => day.is_workday).length
        // "so far" only while the month has days left in it — a June read in
        // August is complete, and saying otherwise invites a second look.
        const days = `${working} working ${working === 1 ? 'day' : 'days'}`
            + (elapsed.length < inMonth.length ? ' so far' : '')
        this.monthTotal.textContent = billable > 0
            ? `${this.formatAmount({ billable_hours: billable })} · ${days}`
            : `Nothing logged · ${days}`
    }

    describeDay(day, row) {
        const parts = [RANGE_FORMAT.format(day)]
        const key = isoDate(day)
        if (key === this.today) return `${parts[0]} — today, still in progress`
        if (key > this.lastComplete) return `${parts[0]} — upcoming`
        parts.push(
            row && row.billable_hours > 0
                ? this.formatAmount(row)
                : 'nothing logged',
        )
        if (row && !row.is_workday) parts.push('non-working day')
        const names = (row?.clients ?? []).map((client) => client.client_name)
        if (names.length) parts.push(names.join(', '))
        return parts.join(' — ')
    }

    /* ---- Selection ---- */

    isSelected(key) {
        if (!this.selectionStart) return false
        if (key < this.selectionStart || key > this.selectionEnd) return false
        if (this.selectionWeekdays === null) return true
        return this.selectionWeekdays.includes(isoWeekday(localDate(key)))
    }

    selectDate(key, shiftHeld = false) {
        // The cells are disabled, so this is a backstop rather than the guard.
        if (key > this.lastComplete) return

        // A weekday filter has no anchor to extend from, so Shift falls back to
        // starting a fresh range rather than doing nothing.
        const extend = shiftHeld
            && this.rangeAnchor !== null
            && this.selectionWeekdays === null

        if (extend) {
            const [start, end] = key < this.rangeAnchor
                ? [key, this.rangeAnchor]
                : [this.rangeAnchor, key]
            this.selectionStart = start
            this.selectionEnd = end
        } else {
            this.selectionStart = key
            this.selectionEnd = key
            this.selectionWeekdays = null
            this.rangeAnchor = key
        }

        this.render()
        this.emit()
    }

    /**
     * Every matching weekday in the visible month; clicking it again clears
     * back to the whole month, so the heading is a toggle rather than a trap.
     *
     * The current month stops at today like everything else, which is what
     * makes "Mondays" mean the Mondays that have happened.
     */
    selectWeekday(weekday) {
        const range = this.monthRange()
        if (range === null) return

        const alreadyOnlyThis = this.selectionWeekdays?.length === 1
            && this.selectionWeekdays[0] === weekday

        const [start, end] = range
        this.selectionStart = start
        this.selectionEnd = end
        this.selectionWeekdays = alreadyOnlyThis ? null : [weekday]
        this.rangeAnchor = alreadyOnlyThis ? start : null

        this.render()
        this.emit()
    }

    /** The visible month, trimmed to today; null once it's entirely ahead. */
    monthRange() {
        return this.clampRange(
            isoDate(startOfMonth(this.month)),
            isoDate(endOfMonth(this.month)),
        )
    }

    /** Point the grid at a range chosen elsewhere — usually a preset chip. */
    setRange(start, end, { weekdays = null, silent = false } = {}) {
        const range = this.clampRange(start, end)
        if (range === null) return Promise.resolve()

        this.selectionStart = range[0]
        this.selectionEnd = range[1]
        this.selectionWeekdays = weekdays
        this.rangeAnchor = weekdays === null ? range[0] : null

        const target = this.focusMonth(range[0], range[1])
        const moved = target.getTime() !== this.month.getTime()
        this.month = target

        const painted = moved ? this.load() : Promise.resolve(this.render())
        if (!silent) this.emit()
        return painted
    }

    changeMonth(amount) {
        this.month = new Date(
            this.month.getFullYear(),
            this.month.getMonth() + amount,
            1,
        )
        this.rescopeWeekdaySelection()
        return this.load()
    }

    showMonthOf(value) {
        this.month = startOfMonth(value)
        this.rescopeWeekdaySelection()
        return this.load()
    }

    /**
     * A weekday selection means "these days, in the month I'm looking at".
     *
     * Paging into a month that hasn't started leaves the selection where it
     * was: there is nothing there to re-scope onto, and dropping the filter
     * would silently answer a different question than the one being asked.
     */
    rescopeWeekdaySelection() {
        if (this.selectionWeekdays === null) return
        const range = this.monthRange()
        if (range === null) return
        this.selectionStart = range[0]
        this.selectionEnd = range[1]
        this.emit()
    }

    selection() {
        return {
            start: this.selectionStart,
            end: this.selectionEnd,
            weekdays: this.selectionWeekdays,
        }
    }

    emit() {
        if (this.selectionStart) this.onChange(this.selection())
    }

    /** ISO dates the selection covers, weekday filter applied. */
    selectedDateKeys() {
        if (!this.selectionStart) return []
        const keys = []
        const end = localDate(this.selectionEnd)
        for (let day = localDate(this.selectionStart); day <= end; day = addDays(day, 1)) {
            if (this.selectionWeekdays === null || this.selectionWeekdays.includes(isoWeekday(day))) {
                keys.push(isoDate(day))
            }
        }
        return keys
    }

    /** How the selection should be named in prose. */
    label() {
        if (!this.selectionStart) return 'Select a date on the calendar.'
        if (this.selectionWeekdays !== null) {
            const names = this.selectionWeekdays.map((day) => `${WEEKDAY_NAMES[day]}s`)
            return `${names.join(', ')} in ${formatSpan(this.selectionStart, this.selectionEnd)}`
        }
        return formatRange(this.selectionStart, this.selectionEnd)
    }
}
