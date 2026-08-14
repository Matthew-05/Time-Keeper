/**
 * The Summary dashboard.
 *
 * One selected range drives the entire page. The calendar owns that selection —
 * the preset chips set it rather than living beside it — so there is exactly
 * one answer to "what am I looking at", and the grid you picked it on is also
 * the grid showing you what's in it.
 *
 * Everything below the calendar comes from a single `/api/summary/overview`
 * read. The KPI strip, the trend chart and the client table are three views of
 * one payload rather than three endpoints that could round differently; a card
 * disagreeing with the total above it is the fastest way to make the whole page
 * untrustworthy.
 *
 * **A selection can't run past today.** Future dates aren't selectable on the
 * grid and every preset chip is cut off at today, so "this month" means the
 * month so far. There is nothing to report on a day that hasn't happened, and
 * a range that included one only ever produced a figure the page then had to
 * explain away. The server's `elapsed()` cut still applies on top — the two
 * agree, and it stays as the backstop for a hand-built request. The calendar
 * grid is the exception and keeps painting future dates, greyed out, because
 * it is a calendar.
 *
 * Budgets are the one exception, and deliberately so: `/api/budgets` already
 * returns every budget with its live figures, and those figures are the
 * budget's own lifetime totals, not the range's. They don't change when the
 * selection does, so they're fetched once and filtered client-side.
 */

import {
    TimeKeeper,
    clientColor,
    formatDecimalHours,
    formatDurationMinutes,
    ready,
    setHtml,
    setText,
} from './base.js'
import { daysSinceWeekStart } from './week_start.js'
import { addDays, endOfMonth, isoDate, startOfMonth } from './calendar_dates.js'
import { SummaryCalendar } from './summary_calendar.js'
import {
    budgetDuration,
    dateRange,
    escapeAttribute,
    headline,
    insightIcon,
    insightIconInline,
    meter,
    percent,
    policyHours,
    shortDate,
    statusInsight,
} from './budget_render.js'
import { insight, note, row } from './insight.js'

/** "Fri, 7 Aug 2026" — for a tooltip, where there's room to be unambiguous. */
function longDate(iso) {
    const [year, month, day] = iso.split('-').map(Number)
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    })
}

/* Beyond this a donut is a colour wheel and a stacked bar is a barcode. Every
   remaining client folds into one grey group; the table below still lists them
   all individually. */
const MIX_SLICES = 8

/** Two decimals, the precision every figure on this page is printed at. */
function round2(value) {
    return Math.round(value * 100) / 100
}

const REFERENCE_LABEL_SIZE = 11
const REFERENCE_LABEL_WEIGHT = 600
/* Clear of the plot, and clear of each other. */
const REFERENCE_LABEL_INSET = 7
const REFERENCE_LABEL_MIN_GAP = 13

function referenceLabelFont() {
    return `${REFERENCE_LABEL_WEIGHT} ${REFERENCE_LABEL_SIZE}px ${Chart.defaults.font.family}`
}

/**
 * Writes each reference line's name in the gutter at its right-hand end.
 *
 * The legend is off — with a dataset per client it was a wall of chips, and the
 * sidebar list already maps colours to clients — so the two lines need to say
 * what they are themselves. Naming them where they end is also strictly better
 * than a legend was: it puts the word next to the line rather than asking you
 * to match a dash pattern across the card.
 *
 * An inline plugin rather than chartjs-plugin-annotation, which isn't vendored;
 * the burn chart in budgets.js paints its held stretches the same way.
 *
 * Room for the text is reserved as `layout.padding.right` when the chart is
 * built, so this draws *outside* `chartArea` and can't cover a bar. Nothing
 * clips it: Chart.js applies and releases its dataset clip inside each
 * dataset's own draw, so by `afterDatasetsDraw` there is none in force.
 */
const referenceLabelPlugin = {
    id: 'referenceLabels',
    afterDatasetsDraw(chart) {
        const { ctx, chartArea } = chart

        const labels = []
        chart.data.datasets.forEach((dataset, index) => {
            if (!dataset.reference) return
            const meta = chart.getDatasetMeta(index)
            if (meta.hidden) return
            const end = meta.data?.[meta.data.length - 1]
            if (!end) return
            labels.push({ text: dataset.label, colour: dataset.borderColor, y: end.y })
        })
        if (!labels.length) return

        /* Capacity ends at zero on a weekend, so the two can end up on top of
           each other. Push them apart from the top down, then lift the stack if
           that has run it past the bottom of the plot. */
        labels.sort((a, b) => a.y - b.y)
        for (let i = 1; i < labels.length; i++) {
            const gap = labels[i].y - labels[i - 1].y
            if (gap < REFERENCE_LABEL_MIN_GAP) {
                labels[i].y = labels[i - 1].y + REFERENCE_LABEL_MIN_GAP
            }
        }
        const overshoot = labels[labels.length - 1].y - chartArea.bottom
        if (overshoot > 0) labels.forEach((label) => { label.y -= overshoot })
        labels.forEach((label) => {
            label.y = Math.max(chartArea.top, label.y)
        })

        ctx.save()
        ctx.font = referenceLabelFont()
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        labels.forEach((label) => {
            // The line's own colour is what ties the word to the line.
            ctx.fillStyle = label.colour
            ctx.fillText(label.text, chartArea.right + REFERENCE_LABEL_INSET, label.y)
        })
        ctx.restore()
    },
}

export class SummaryDashboard extends TimeKeeper {
    constructor() {
        super()

        this.selection = null
        this.overview = null
        this.budgets = null
        this.budgetsPromise = null
        // Null until a payload says otherwise, which is the whole rate-ready
        // seam — see `amount()`.
        this.currency = null
        this.charts = { trend: null, mix: null }
        this.sort = { key: 'billable_hours', direction: 'desc' }
        // A view toggle, not a preference: deliberately in memory only rather
        // than in settings.json, which is for things that should outlive the
        // page. See trendDays() for what it does and doesn't hide.
        this.showNonWorkingDays = false
        this.refreshToken = 0
        this.retryTimer = null
        this.clientFilter = document.getElementById('summary-client-filter')
        this.clientFilterClear = document.getElementById('summary-client-filter-clear')
        this.clientFilterPicker = null
        this.clientFilterValue = this.clientFilter.value

        this.calendar = new SummaryCalendar({
            fetchWindow: (start, end) => this.fetchFromAPI(
                `/api/summary/calendar?${this.summaryParams(start, end)}`,
            ),
            onChange: (selection) => this.selectRange(selection),
            formatAmount: (row) => this.amount(row, { compact: true }),
        })
    }

    init() {
        this.initializeClientFilter()
        this.bindEvents()
        /* This week so far — Monday (or Sunday, if that's the preference) up to
           yesterday. On the first day of the week that range is empty, so the
           page opens on last week rather than on nothing; `last-week` is always
           complete and always selectable. Utilisation still measures against
           *elapsed* capacity server-side, so a Tuesday doesn't read as a crisis
           either way. */
        const selection = this.presetSelection('this-week')
            ?? this.presetSelection('last-week')
        this.calendar.start(selection)
        this.selectRange(selection)
    }

    bindEvents() {
        document.getElementById('summary-presets').addEventListener('click', (event) => {
            const chip = event.target.closest('[data-preset]')
            const args = chip && this.presetArgs(chip.dataset.preset)
            if (args) this.calendar.setRange(...args)
        })

        document.getElementById('summary-client-table').addEventListener('click', (event) => {
            const header = event.target.closest('[data-sort]')
            if (header) this.sortBy(header.dataset.sort)
        })

        document.addEventListener('click', (event) => {
            const client = event.target.closest('[data-summary-client-id]')
            if (client) this.selectClient(client.dataset.summaryClientId)
        })

        this.clientFilter.addEventListener('change', () => this.applyClientFilter())
        this.clientFilterClear.addEventListener('click', () => this.clearClientFilter())

        // aria-checked is the only source of truth for the switch, matching
        // the settings page — there's no hidden input to keep in step with.
        const nonWorking = document.getElementById('summary-show-non-working')
        nonWorking.addEventListener('click', () => {
            this.showNonWorkingDays = nonWorking.getAttribute('aria-checked') !== 'true'
            nonWorking.setAttribute('aria-checked', this.showNonWorkingDays ? 'true' : 'false')
            if (this.overview) this.renderTrendChart()
        })

        // Chart.js bakes its colours in at construction, so a theme switch has
        // to rebuild rather than repaint. See the styling notes in CLAUDE.md.
        document.addEventListener('themeChanged', () => {
            if (this.overview) this.renderCharts()
        })
    }

    /* ---- Ranges ---- */

    initializeClientFilter() {
        this.clientFilterPicker = new Choices(this.clientFilter, {
            searchPlaceholderValue: 'Start typing client name...',
            searchResultLimit: 10,
            shouldSort: false,
            itemSelectText: '',
            placeholder: true,
            placeholderValue: 'All clients',
        })
    }

    /** Query parameters shared by the range and calendar summary reads. */
    summaryParams(start, end, weekdays = null) {
        const params = new URLSearchParams({ start, end })
        if (weekdays) params.set('weekdays', weekdays.join(','))
        if (this.clientFilter.value) params.set('client_id', this.clientFilter.value)
        return params
    }

    /** Set the picker from a client named elsewhere on the page. */
    selectClient(clientId) {
        const value = String(clientId)
        if (!value || value === this.clientFilter.value) return
        this.clientFilterPicker.setChoiceByValue(value)
        this.applyClientFilter()
    }

    clearClientFilter() {
        if (!this.clientFilter.value) return
        this.clientFilterPicker.removeActiveItems()
        this.clientFilter.value = ''
        this.applyClientFilter()
    }

    /** Reload both views which are scoped by the selected client. */
    applyClientFilter() {
        const value = this.clientFilter.value
        this.clientFilterClear.hidden = !value
        if (value === this.clientFilterValue) return
        this.clientFilterValue = value
        this.calendar.load()
        this.refresh()
    }

    /** `[start, end]` as dates for a preset chip. */
    presetRange(name) {
        const today = new Date()
        const monthStart = startOfMonth(today)

        switch (name) {
            case 'this-week': {
                const start = addDays(today, -daysSinceWeekStart(today))
                return [start, addDays(start, 6)]
            }
            case 'last-week': {
                const start = addDays(today, -daysSinceWeekStart(today) - 7)
                return [start, addDays(start, 6)]
            }
            case 'this-month':
                return [monthStart, endOfMonth(today)]
            case 'last-month': {
                const start = new Date(today.getFullYear(), today.getMonth() - 1, 1)
                return [start, endOfMonth(start)]
            }
            case 'this-quarter': {
                const first = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1)
                return [first, endOfMonth(new Date(first.getFullYear(), first.getMonth() + 2, 1))]
            }
            // 30 *complete* days, ending yesterday. Counting back from today
            // would give 29 of them once the clamp had taken today off the end,
            // and a chip that says 30 has to light 30 cells.
            case 'last-30':
            default:
                return [addDays(today, -30), addDays(today, -1)]
        }
    }

    /**
     * A preset as an ISO selection, **cut off at yesterday**, or null if none
     * of it has finished happening.
     *
     * "This week" on a Wednesday is Monday to Tuesday: today's total is still
     * moving, so including it would put a figure on the page that changes
     * while you read it. On the first day of a week or a month the preset has
     * nothing left in it at all — hence the null, which the chip renders as
     * disabled rather than as a click that does nothing.
     *
     * The clamp lives here as well as in the calendar because
     * `markActivePreset()` compares a chip's range against the selection
     * character for character — a chip that set a range the calendar then
     * trimmed would never light up again.
     */
    presetSelection(name) {
        const [start, end] = this.presetRange(name)
        const limit = isoDate(addDays(new Date(), -1))
        const startKey = isoDate(start)
        if (startKey > limit) return null
        const endKey = isoDate(end)
        return {
            start: startKey,
            end: endKey > limit ? limit : endKey,
            weekdays: null,
        }
    }

    presetArgs(name) {
        const selection = this.presetSelection(name)
        return selection && [selection.start, selection.end]
    }

    /** Adopt a range and reload everything that depends on it. */
    selectRange(selection) {
        this.selection = selection
        // Painted from the selection alone, before any request goes out — the
        // panel should confirm the click immediately, not a round-trip later.
        this.renderSelectionHeader()
        this.markActivePreset()
        this.refresh()
    }

    /**
     * Light the chip whose range matches the selection exactly.
     *
     * Nothing is lit after a Shift-drag on the calendar, which is correct: the
     * chips are shortcuts to particular ranges, not a mode the page is in, and
     * leaving one lit next to a range it doesn't describe would be a lie.
     */
    markActivePreset() {
        document.querySelectorAll('#summary-presets [data-preset]').forEach((chip) => {
            const range = this.presetArgs(chip.dataset.preset)
            // "This week" on a Monday has no completed day in it. Disabled
            // rather than hidden: the row of chips shouldn't reflow by the day.
            chip.disabled = range === null
            const active = range !== null
                && this.selection.weekdays === null
                && this.selection.start === range[0]
                && this.selection.end === range[1]
            chip.classList.toggle('active', active)
            chip.setAttribute('aria-pressed', active ? 'true' : 'false')
        })
    }

    /* ---- Loading ---- */

    /** Budgets don't depend on the range, so they're fetched once per visit. */
    loadBudgets() {
        if (!this.budgetsPromise) {
            this.budgetsPromise = this.fetchFromAPI('/api/budgets')
        }
        return this.budgetsPromise
    }

    async refresh() {
        const token = ++this.refreshToken
        clearTimeout(this.retryTimer)

        const params = this.summaryParams(
            this.selection.start,
            this.selection.end,
            this.selection.weekdays,
        )

        try {
            const [overview, budgets] = await Promise.all([
                this.fetchFromAPI(`/api/summary/overview?${params}`),
                this.loadBudgets(),
            ])
            // A slower request for a range the user has already moved off.
            if (token !== this.refreshToken) return

            this.overview = overview
            this.budgets = budgets
            this.currency = overview.currency
            this.render()
        } catch (error) {
            if (token !== this.refreshToken) return
            console.error('Could not load the summary:', error)
            // fetchFromAPI has already retried for about a minute, so this is
            // a real outage. Never leave the placeholders up — say what's
            // happening and keep trying, since there's nothing to click.
            this.showDisconnected()
            this.budgetsPromise = null
            this.retryTimer = setTimeout(() => this.refresh(), 3000)
        }
    }

    /* ---- Formatting ---- */

    /**
     * The one place a billable figure becomes text.
     *
     * Every payload carries a `billable_amount` beside its `billable_hours`,
     * currently always null because there are no rates in the schema. When
     * there are, this starts returning money and nothing else on the page
     * changes — which is the entire reason the field ships null rather than
     * being absent.
     */
    amount(entry, { compact = false } = {}) {
        if (entry?.billable_amount != null) return this.money(entry.billable_amount)
        return this.hours(entry?.billable_hours ?? 0, { compact })
    }

    /**
     * A duration, in whichever unit the rounding policy makes meaningful.
     *
     * Rounded values are decimal hours because that's what a 15-minute policy
     * produces and what an invoice carries. Unrounded ones are hours and
     * minutes, because "6.38" is not a thing anybody logged.
     */
    hours(value, { compact = false } = {}) {
        if (this.roundingEnabled) {
            const figure = formatDecimalHours(value)
            return compact ? `${figure}h` : `${figure} hrs`
        }

        const minutes = Math.max(0, Math.round(value * 60))
        if (!compact) return formatDurationMinutes(minutes)
        const whole = Math.floor(minutes / 60)
        const rest = minutes % 60
        return rest ? `${whole}h ${rest}m` : `${whole}h`
    }

    /** Unreachable until a rate exists; here so `amount()` has both branches. */
    money(value) {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: this.currency || 'USD',
        }).format(value)
    }

    signedHours(value) {
        const sign = value > 0 ? '+' : '−'
        return `${sign}${this.hours(Math.abs(value), { compact: true })}`
    }

    escape(value) {
        const holder = document.createElement('div')
        holder.textContent = value == null ? '' : String(value)
        return holder.innerHTML
    }

    clientName(client, className = '') {
        const name = this.escape(client.client_name)
        if (client.client_id == null) return `<span class="${className}">${name}</span>`
        return `<button type="button" class="tk-summary-client-link ${className}"`
            + ` data-summary-client-id="${client.client_id}"`
            + ` title="Filter by ${escapeAttribute(client.client_name)}">${name}</button>`
    }

    /* ---- Rendering ---- */

    render() {
        this.renderSelectionHeader()
        this.renderKpis()
        this.renderCapacity()
        this.renderSelectionClients()
        this.renderCharts()
        this.renderClientTable()
        this.renderBudgets()
    }

    /**
     * The badge and meta line beside the calendar.
     *
     * The badge counts the selection, elapsed or not — it describes what was
     * clicked, and a range that shrank the moment you picked it would be
     * baffling. When part of that selection is still ahead it says so as
     * "3 of 7 days", which is the one place on the page the gap between the
     * two is stated outright, and the thing that explains why every figure
     * below describes less than the range appears to cover.
     */
    renderSelectionHeader() {
        setText(document.getElementById('summary-selection-label'), this.calendar.label())
        const totals = this.overview?.totals
        const count = this.calendar.selectedDateKeys().length
        const elapsed = totals?.days_in_range ?? count
        setText(
            document.getElementById('summary-selection-count'),
            elapsed < count
                ? `${elapsed} of ${count} days`
                : `${count} ${count === 1 ? 'day' : 'days'}`,
        )

        setText(
            document.getElementById('summary-selection-meta'),
            totals
                ? `${totals.workdays} ${totals.workdays === 1 ? 'workday' : 'workdays'}`
                    + ` · ${totals.days_worked} worked`
                    + (totals.days_in_range < totals.days_selected ? ' · so far' : '')
                : ' ',
        )
    }

    renderKpis() {
        const totals = this.overview.totals

        setText(document.getElementById('kpi-billable'), this.amount(totals))
        setText(
            document.getElementById('kpi-billable-note'),
            this.roundingEnabled
                ? `${this.hours(totals.tracked_hours, { compact: true })} logged`
                    + (Math.abs(totals.rounding_delta_hours) < 0.005
                        ? ''
                        : ` · ${this.signedHours(totals.rounding_delta_hours)} rounding`)
                : `across ${totals.days_in_range} ${totals.days_in_range === 1 ? 'day' : 'days'}`,
        )

        setText(
            document.getElementById('kpi-utilisation'),
            percent(totals.utilisation_percent),
        )
        setText(
            document.getElementById('kpi-utilisation-note'),
            totals.capacity_hours
                ? `of ${this.hours(totals.capacity_hours, { compact: true })} capacity`
                    + (totals.days_in_range < totals.days_selected ? ' so far' : '')
                : 'no working days yet',
        )

        setText(document.getElementById('kpi-days'), String(totals.days_worked))
        setText(
            document.getElementById('kpi-days-note'),
            `of ${totals.workdays} ${totals.workdays === 1 ? 'workday' : 'workdays'}`
                + (totals.workdays < totals.workdays_selected ? ' so far' : ' in range'),
        )

        setText(
            document.getElementById('kpi-average'),
            this.amount({ billable_hours: totals.avg_billable_per_worked_day }),
        )
        setText(
            document.getElementById('kpi-average-note'),
            totals.busiest_day
                ? `busiest ${shortDate(totals.busiest_day.date)}`
                    + ` · ${this.hours(totals.busiest_day.billable_hours, { compact: true })}`
                : ' ',
        )

        setText(document.getElementById('kpi-clients'), String(totals.client_count))
        setText(
            document.getElementById('kpi-clients-note'),
            totals.top_client_share_percent == null
                ? ' '
                : `${percent(totals.top_client_share_percent)} on ${this.overview.clients[0].client_name}`,
        )
    }

    /**
     * Billable against the capacity that has elapsed.
     *
     * Deliberately uncoloured: unlike a budget, there is no such thing as a
     * correct utilisation, and painting 120% red would be inventing a judgement
     * the app has no basis for. Above 100% gets the same hatch a budget overage
     * does, which says "past the line" without saying "bad".
     */
    renderCapacity() {
        const totals = this.overview.totals
        const used = totals.utilisation_percent
        const fill = document.getElementById('summary-capacity-fill')

        fill.style.width = `${Math.min(100, Math.max(0, used ?? 0))}%`
        fill.classList.toggle('tk-meter-overflow', (used ?? 0) > 100)

        setText(document.getElementById('summary-capacity-percent'), percent(used))
        setText(
            document.getElementById('summary-capacity-note'),
            totals.capacity_hours
                ? `${this.amount(totals)} of ${this.hours(totals.capacity_hours)} `
                    + `across ${totals.workdays} elapsed `
                    + `${totals.workdays === 1 ? 'workday' : 'workdays'}`
                : totals.days_in_range
                    ? 'No working days have elapsed in this range.'
                    : 'This range hasn\'t started yet.',
        )
    }

    /**
     * The client list beside the calendar.
     *
     * Doubles as the legend for the dots on the cells — same hash-derived
     * colour per client — so the grid and this list can be read against each
     * other without a key in between.
     */
    renderSelectionClients() {
        const container = document.getElementById('summary-selection-clients')
        const clients = this.overview.clients

        if (!clients.length) {
            setHtml(container, '<p class="text-xs text-faint">Nothing logged in this range.</p>')
            return
        }

        setHtml(container, clients.map((client) => `
            <div class="tk-mix-row">
              <span class="tk-mix-swatch" style="background-color: ${clientColor(client.client_name, client.client_color)}"></span>
              ${this.clientName(client, 'min-w-0 flex-1 truncate text-xs text-text')}
              <span class="tabular flex-shrink-0 text-xs font-semibold text-text">${this.amount(client, { compact: true })}</span>
              <span class="tabular w-9 flex-shrink-0 text-right text-xs text-faint">${percent(client.share_percent)}</span>
            </div>
        `).join(''))
    }

    renderCharts() {
        this.renderTrendChart()
        this.renderTrendStats()
        this.renderMixChart()
    }

    /**
     * Live theme tokens, so a rebuilt chart matches the page it's on.
     *
     * `--accent` and `--muted` were dropped from here when the bars went
     * per-client and the legend went away — they were the single bar colour and
     * the legend's label colour, and nothing else asked for either. `--surface`
     * went the same way with the hairline between stacked segments.
     */
    tokens() {
        const css = getComputedStyle(document.documentElement)
        const read = (name) => css.getPropertyValue(name).trim()
        return {
            text: read('--text'),
            faint: read('--faint'),
            border: read('--border'),
        }
    }

    /**
     * How clients are grouped wherever a chart colours by client.
     *
     * Shared by the donut and the stacked bars so the two can't disagree about
     * which client is which colour — and both agree with the sidebar list and
     * the calendar dots, since every colour comes from the same `clientColor()`
     * hash of the name.
     *
     * Grouping is by the client's total across the whole range, not per day, so
     * a client keeps its colour and its position in the stack from one bar to
     * the next. Ranking each day separately would make the stack shuffle.
     *
     * Clients that rounded away to nothing are dropped: a zero-height segment
     * is invisible on the chart but still takes a legend entry.
     */
    mixGroups() {
        const clients = this.overview.clients.filter((client) => client.billable_seconds > 0)
        const groups = clients.slice(0, MIX_SLICES).map((client) => ({
            label: client.client_name,
            clientId: client.client_id,
            colour: clientColor(client.client_name, client.client_color),
            names: new Set([client.client_name]),
            billable_hours: client.billable_hours,
        }))

        const rest = clients.slice(MIX_SLICES)
        if (rest.length) {
            groups.push({
                label: `${rest.length} more`,
                colour: this.tokens().faint,
                names: new Set(rest.map((client) => client.client_name)),
                billable_hours: round2(
                    rest.reduce((total, client) => total + client.billable_seconds, 0) / 3600,
                ),
            })
        }
        return groups
    }

    /**
     * The days the trend chart plots.
     *
     * With the switch off, a non-working day is dropped **only when nothing was
     * billed on it**. A Saturday you actually worked is precisely the day you'd
     * want to see, so it stays regardless — the switch hides empty weekends and
     * holidays, nothing else.
     *
     * That leaves the visible bars identical to the set the average is taken
     * over (`totals.active_days`), which is why the figure always reads as the
     * bars look. Turning the switch on adds empty days around it and does not
     * move it.
     *
     * `overview.days` arrives already cut to the elapsed range, so the switch
     * can't reveal a day that hasn't happened — an empty Friday column on a
     * Wednesday would be indistinguishable from a Friday nobody worked.
     */
    trendDays() {
        const days = this.overview.days
        if (this.showNonWorkingDays) return days
        return days.filter((day) => day.is_workday || day.billable_hours > 0)
    }

    renderTrendChart() {
        const days = this.trendDays()
        const body = document.getElementById('summary-trend-body')

        // Both reachable: a weekend selected on its own with nothing logged has
        // no day left to plot once the empties are hidden, and a range picked
        // entirely in the future has no elapsed day to plot at all.
        if (!days.length) {
            this.charts.trend?.destroy()
            this.charts.trend = null
            setHtml(body, '<div class="tk-empty flex h-full items-center justify-center">'
                + (this.overview.totals.days_in_range
                    ? 'Nothing to plot — this range is all non-working days with no time on them.'
                    : 'Nothing to plot yet — this range is still ahead.')
                + '</div>')
            return
        }

        if (!document.getElementById('summary-trend-chart')) {
            setHtml(body, '<canvas id="summary-trend-chart"></canvas>')
        }

        const canvas = this.resetCanvas('trend', 'summary-trend-chart')
        const token = this.tokens()
        const groups = this.mixGroups()

        /* One dataset per client, stacked. The stack itself is the breakdown,
           so the hover gets it for free — no hand-built afterBody listing the
           split under a single-colour bar.

           No border between segments. There was a hairline in the card colour,
           on the theory that two clients whose hashed hues land near each other
           would read as one block; in practice it cut a gap through every bar
           and the stack read as a dashed column rather than a day. The colours
           carry the split on their own, and the hover names them exactly.

           Only the outer edges are rounded: rounding every segment turns a
           stack into a column of separate pills. */
        const datasets = groups.map((group) => ({
            label: group.label,
            data: days.map((day) => round2(
                day.clients.reduce(
                    (total, entry) => (group.names.has(entry.client_name)
                        ? total + entry.billable_seconds
                        : total),
                    0,
                ) / 3600,
            )),
            // Every client shares one stack, so the bar's height is the day's
            // total. Chart.js keys stacks on `stack || type`, which is also why
            // the two reference lines below each need a key of their own.
            stack: 'clients',
            backgroundColor: group.colour,
            clientId: group.clientId,
            borderWidth: 0,
            borderRadius: 2,
            borderSkipped: false,
            maxBarThickness: 44,
            order: 3,
        }))

        /* The two reference lines, back over the stack.
         *
         * `reference: true` is ours, not Chart.js's — unknown dataset keys pass
         * straight through, and the tooltip filter reads it to keep both lines
         * out of the hover. They're context for the bars, not another figure to
         * read off them, and their exact values are in the footer below.
         *
         * Each needs its own `stack`. Both are lines, so they would otherwise
         * share the default `line` stack key and the average would be drawn
         * sitting on top of capacity rather than at its own height.
         *
         * `order` is drawing order and Chart.js walks its sorted metasets
         * backwards, so the *lowest* order paints last, on top. Both lines have
         * to beat the bars or the stack would bury them.
         */
        const average = this.overview.totals.avg_billable_per_active_day
        datasets.push({
            type: 'line',
            label: 'Capacity',
            data: days.map((day) => day.capacity_hours),
            stack: 'capacity',
            reference: true,
            borderColor: token.faint,
            borderDash: [5, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            // Capacity is a step function — 8 on a Friday, 0 on the Saturday.
            // Interpolating would draw a slope nobody's schedule has.
            stepped: 'middle',
            order: 2,
        })

        if (Number.isFinite(average)) {
            datasets.push({
                type: 'line',
                label: 'Average',
                data: days.map(() => average),
                stack: 'average',
                reference: true,
                borderColor: token.text,
                borderDash: [2, 3],
                borderWidth: 1.5,
                pointRadius: 0,
                order: 1,
            })
        }

        /* Reserve exactly the gutter the labels need, measured rather than
           guessed — a fixed number would either crop "Capacity" or leave a
           gap once the font or the wording changed. */
        const context = canvas.getContext('2d')
        context.font = referenceLabelFont()
        const gutter = REFERENCE_LABEL_INSET + Math.ceil(Math.max(
            ...datasets.filter((set) => set.reference)
                .map((set) => context.measureText(set.label).width),
            0,
        ))

        this.charts.trend = new Chart(context, {
            type: 'bar',
            data: {
                labels: days.map((day) => day.date),
                datasets,
            },
            plugins: [referenceLabelPlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                onClick: (event, _elements, chart) => {
                    const [hit] = chart.getElementsAtEventForMode(
                        event,
                        'nearest',
                        { intersect: true },
                        true,
                    )
                    const clientId = chart.data.datasets[hit?.datasetIndex]?.clientId
                    if (clientId != null) this.selectClient(clientId)
                },
                layout: { padding: { right: gutter } },
                plugins: {
                    // Off: a chip per client was a wall of them, and the
                    // sidebar list already maps every colour to its client.
                    // The two lines name themselves at their right-hand end.
                    legend: { display: false },
                    tooltip: {
                        /* A range with nothing logged has no client datasets at
                           all, so there is no bar to describe and the filter
                           below has no zero item to fall back on. Chart.js would
                           still draw the box, empty, trailing the cursor. */
                        enabled: groups.length > 0,
                        /* Two exclusions. Capacity and Average are reference
                           lines — the same figure on every bar, and both are
                           stated exactly in the footer, so repeating them in
                           every hover is noise. And with a dataset per client,
                           an unfiltered index tooltip lists every client on
                           every day, nearly all of them reading zero.

                           The catch is that an index tooltip still activates on
                           a day where nothing was billed, and there both rules
                           together throw every item away. Chart.js goes on to
                           build the tooltip regardless — `_active` is decided
                           before `filter` runs — so the callbacks below get an
                           empty array, `items[0]` is undefined, and the throw
                           leaves a half-built model that then fails again in
                           `_drawColorBox`. So one zero item is kept, purely to
                           carry the date, and labelled as the empty day it is. */
                        filter: (item, _index, items) => {
                            if (item.dataset.reference) return false
                            const billed = items.some(
                                (entry) => !entry.dataset.reference && entry.parsed.y > 0,
                            )
                            return billed ? item.parsed.y > 0 : item.datasetIndex === 0
                        },
                        callbacks: {
                            // Every callback still guards the empty case: a
                            // range with no clients at all has no dataset 0 to
                            // keep, so the filter can't rescue it.
                            title: (items) => {
                                const day = days[items[0]?.dataIndex]
                                if (!day) return ''
                                return longDate(day.date)
                                    + (day.is_workday ? '' : ' · non-working day')
                            },
                            label: (item) => (item.parsed.y > 0
                                ? `${item.dataset.label}: `
                                    + this.hours(item.parsed.y, { compact: true })
                                : 'Nothing logged'),
                            // The placeholder gets no swatch — a colour box
                            // would name a client that wasn't worked.
                            labelColor: (item) => ({
                                backgroundColor: item.parsed.y > 0
                                    ? item.dataset.backgroundColor
                                    : 'transparent',
                                borderColor: 'transparent',
                                borderWidth: 0,
                                borderRadius: 2,
                            }),
                            // Worth stating outright: with several segments the
                            // day's total is the one number the stack doesn't
                            // hand you directly.
                            footer: (items) => {
                                if (items.length < 2) return undefined
                                const day = days[items[0]?.dataIndex]
                                if (!day) return undefined
                                return `Total: ${this.hours(day.billable_hours, { compact: true })}`
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        stacked: true,
                        ticks: {
                            color: token.faint,
                            maxRotation: 0,
                            autoSkip: true,
                            maxTicksLimit: 12,
                            callback: (_value, index) => shortDate(days[index]?.date),
                        },
                        grid: { display: false },
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: {
                            color: token.faint,
                            callback: (value) => this.hours(value, { compact: true }),
                        },
                        grid: { color: token.border },
                    },
                },
            },
        })
    }

    /**
     * The three figures under the plot.
     *
     * All three are range-level constants rather than anything that varies day
     * to day, so they belong here as numbers rather than as rules across the
     * chart. Each states its own basis — the average especially, since the KPI
     * strip carries a *different* average (per day worked) and the two would
     * otherwise look like a contradiction.
     */
    renderTrendStats() {
        const totals = this.overview.totals
        const average = totals.avg_billable_per_active_day

        if (Number.isFinite(average) && totals.active_days) {
            setText(document.getElementById('trend-average'),
                `${this.amount({ billable_hours: average }, { compact: true })} / day`)
            setText(document.getElementById('trend-average-note'),
                `over ${totals.active_days} ${totals.active_days === 1 ? 'day' : 'days'}`
                + ' — workdays, plus any day billed')
        } else if (Number.isFinite(average)) {
            // A real payload with no day to average over: nothing has elapsed
            // yet, or the selection is a weekend nobody worked. There is no
            // average here, and "0h / day over 0 days" reads as a figure rather
            // than as the absence of one — the same trap the stale branch below
            // exists to avoid, arrived at from the other direction.
            setText(document.getElementById('trend-average'), '—')
            setText(document.getElementById('trend-average-note'),
                totals.days_in_range
                    ? 'No days billed or scheduled in this range'
                    : 'This range is still ahead')
        } else {
            setText(document.getElementById('trend-average'), '—')
            setText(document.getElementById('trend-average-note'), ' ')
            this.warnStale('avg_billable_per_active_day')
        }

        this.renderCapacityRatio()
        this.renderNonWorkingStat()
    }

    /**
     * A field the payload should have carried and didn't.
     *
     * Always a stale Flask process: templates and static JS reload on their own
     * in dev, but a change to summary.py needs the app restarting, so the page
     * can be new while the payload it's reading is old.
     *
     * Every caller pairs this with an em dash rather than a zero, which matters
     * more than it looks: a missing capacity rendered as "0h / day" is a
     * perfectly plausible reading of a real schedule, so it gets investigated
     * as a capacity bug instead of as the restart it is.
     */
    warnStale(field) {
        console.warn(
            `Summary: totals.${field} is missing from the payload. `
            + 'Restart the app if summary.py has changed.',
        )
    }

    /**
     * The average day against the scheduled day, as one percentage.
     *
     * Not the same question as the Utilisation card above, though the two agree
     * whenever nothing was worked off-schedule. Utilisation divides the whole
     * billable total by the whole elapsed capacity. This divides the average
     * *billed* day by the average *scheduled* day, and those have different
     * denominators the moment a weekend is worked: a Saturday is another day in
     * the average without being another day of capacity, so it pulls this
     * figure down while pushing utilisation up. That divergence is the useful
     * part — read together, the pair says whether a good week was a good week
     * or a week that spilled into the weekend.
     *
     * Which two averages those are is the only thing anyone needs to know about
     * the number, so they go in the popover rather than in a note under it.
     */
    renderCapacityRatio() {
        const totals = this.overview.totals
        const ratio = totals.avg_vs_capacity_percent
        const average = totals.avg_billable_per_active_day
        const capacity = totals.avg_capacity_per_workday
        const value = document.getElementById('trend-capacity')
        const detail = document.getElementById('trend-capacity-note')
        const icon = document.getElementById('trend-capacity-insight')

        if (capacity == null) {
            setText(value, '—')
            setText(detail, ' ')
            setHtml(icon, '')
            this.warnStale('avg_capacity_per_workday')
            return
        }

        setText(value, percent(ratio))

        if (ratio == null) {
            // No scheduled capacity to be a share of: a weekend picked on its
            // own, a stretch of leave, or a range still ahead.
            setText(detail, totals.days_in_range
                ? 'No capacity scheduled in this range'
                : 'This range is still ahead')
            // And nothing for the popover to explain — it would name two
            // averages that are both zero, contradicting the line above it.
            setHtml(icon, '')
            return
        }

        setText(detail, `${this.hours(average, { compact: true })} of `
            + `${this.hours(capacity, { compact: true })} a day`)

        setHtml(icon, insightIcon(
            insight(
                row('Average billed', `${this.hours(average, { compact: true })} / day`),
                row('Average capacity', `${this.hours(capacity, { compact: true })} / day`),
                note(`Billed over ${totals.active_days} active `
                    + `${totals.active_days === 1 ? 'day' : 'days'}, scheduled over `
                    + `${totals.workdays} ${totals.workdays === 1 ? 'workday' : 'workdays'}. `
                    + 'Days still ahead are not counted.'),
            ),
            'Average against capacity',
        ))
    }

    /**
     * Time billed on days the schedule never asked for.
     *
     * Every other figure on the page treats a worked weekend as ordinary
     * billable time — it is, and the invoice agrees — which leaves nothing
     * saying the week ran over its own edges. This is that. It sits under the
     * chart rather than in the strip because the bars it describes are right
     * above it: the days with no capacity line under them.
     */
    renderNonWorkingStat() {
        const off = this.overview.totals.non_working
        const value = document.getElementById('trend-non-working')
        const note_ = document.getElementById('trend-non-working-note')

        if (!off) {
            setText(value, '—')
            setText(note_, ' ')
            this.warnStale('non_working')
            return
        }

        setText(value, this.amount(off, { compact: true }))
        setText(note_, off.days_worked
            ? `across ${off.days_worked} non-working `
                + `${off.days_worked === 1 ? 'day' : 'days'}`
            : 'no time on non-working days')
    }

    renderMixChart() {
        const canvas = this.resetCanvas('mix', 'summary-mix-chart')
        const groups = this.mixGroups()
        if (!groups.length) return

        this.charts.mix = new Chart(canvas.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: groups.map((group) => group.label),
                datasets: [{
                    data: groups.map((group) => group.billable_hours),
                    backgroundColor: groups.map((group) => group.colour),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: (_event, elements, chart) => {
                    const clientId = groups[elements[0]?.index]?.clientId
                    if (clientId != null) this.selectClient(clientId)
                },
                // The list in the sidebar and the table below are both already
                // legends for this; a third would crowd out the donut itself.
                cutout: '62%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (item) => ` ${this.hours(item.parsed, { compact: true })}`,
                        },
                    },
                },
            },
        })
    }

    /**
     * A fresh canvas for one chart.
     *
     * Chart.js keeps a registry keyed on the canvas element, so reusing one
     * without destroying its chart first throws "Canvas is already in use".
     */
    resetCanvas(key, id) {
        this.charts[key]?.destroy()
        this.charts[key] = null
        return document.getElementById(id)
    }

    /* ---- Client table ---- */

    sortBy(key) {
        // Names read best A–Z on first click; every figure reads best largest
        // first, because "who did I spend the most on" is the actual question.
        this.sort = this.sort.key === key
            ? { key, direction: this.sort.direction === 'desc' ? 'asc' : 'desc' }
            : { key, direction: key === 'client_name' ? 'asc' : 'desc' }
        this.renderClientTable()
    }

    sortedClients() {
        const { key, direction } = this.sort
        const sign = direction === 'asc' ? 1 : -1
        return [...this.overview.clients].sort((a, b) => {
            if (key === 'client_name') {
                return sign * a.client_name.localeCompare(b.client_name)
            }
            return sign * ((a[key] ?? 0) - (b[key] ?? 0))
                // A stable tiebreak, so two clients on the same figure don't
                // swap places every time the table is redrawn.
                || a.client_name.localeCompare(b.client_name)
        })
    }

    /* Five columns whether rounding is on or not. There used to be a sixth
       holding each client's unrounded "Logged" figure, which is the one number
       here nobody bills and nobody reconciles against — the range-level
       rounding delta in the KPI strip already says what the policy is worth,
       and it says it in one figure rather than a column of near-duplicates of
       the column beside it. */
    static COLUMNS = 5

    renderClientTable() {
        const clients = this.sortedClients()
        const body = document.getElementById('summary-client-rows')

        setText(
            document.getElementById('summary-client-count'),
            `${clients.length} ${clients.length === 1 ? 'client' : 'clients'}`,
        )

        document.querySelectorAll('#summary-client-table [data-sort]').forEach((header) => {
            const active = header.dataset.sort === this.sort.key
            header.classList.toggle('active', active)
            header.dataset.direction = active ? this.sort.direction : ''
            header.closest('th').setAttribute(
                'aria-sort',
                active ? (this.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none',
            )
        })

        if (!clients.length) {
            setHtml(body, `<tr><td colspan="${SummaryDashboard.COLUMNS}">`
                + '<div class="tk-empty py-8">Nothing logged in this range.</div></td></tr>')
            return
        }

        setHtml(body, clients.map((client) => `
            <tr>
              <td>
                <span class="flex min-w-0 items-center gap-2">
                  <span class="tk-mix-swatch" style="background-color: ${clientColor(client.client_name, client.client_color)}"></span>
                  ${this.clientName(client, 'truncate')}
                </span>
              </td>
              <td class="tk-num text-right font-semibold">${this.amount(client, { compact: true })}</td>
              <td class="tk-num text-right">${client.days_worked}</td>
              <td class="tk-num text-right">${this.hours(client.avg_billable_per_day, { compact: true })}</td>
              <td class="tk-num text-right">
                <span class="flex items-center justify-end gap-2">
                  <span class="tk-share-bar"><span style="width: ${client.share_percent ?? 0}%"></span></span>
                  <span class="w-14 text-right">${client.share_percent == null ? '—' : `${client.share_percent.toFixed(2)}%`}</span>
                </span>
              </td>
            </tr>
        `).join(''))
    }

    /* ---- Budgets ---- */

    renderBudgets() {
        const section = document.getElementById('summary-budgets')
        const { start_date: start, end_date: end } = this.overview
        // Inclusive overlap at both ends, matching how a budget's own range is
        // defined. Order is whatever /api/budgets gave: live by end date, then
        // closed — already the order you'd want to read them in.
        const touching = (this.budgets || []).filter(
            (budget) => budget.start_date <= end
                && budget.end_date >= start
                && (!this.clientFilter.value
                    || String(budget.client_id) === this.clientFilter.value),
        )

        section.hidden = !touching.length
        if (!touching.length) return

        setText(
            document.getElementById('summary-budget-count'),
            `${touching.length} ${touching.length === 1 ? 'budget' : 'budgets'}`,
        )
        setHtml(
            document.getElementById('summary-budget-list'),
            touching.map((budget) => this.budgetRow(budget)).join(''),
        )
    }

    budgetRow(budget) {
        const icon = statusInsight(budget)
        // An anchor, so the row behaves like every other link to a budget in
        // the app — hence insightIconInline rather than insightIcon: a <button>
        // inside an <a> is invalid and browsers unnest it.
        return `
            <a href="/budgets?budget_id=${encodeURIComponent(budget.id)}"
               class="tk-status-scope tk-budget-row block no-underline"
               data-status="${escapeAttribute(budget.status)}">
              <div class="mb-1 flex items-baseline justify-between gap-3">
                <span class="min-w-0 truncate text-sm font-semibold text-text">${this.escape(budget.name)}</span>
                <span class="tabular flex-shrink-0 text-sm font-semibold" style="color: var(--status-text)">
                  ${percent(budget.percent_used_exact ?? budget.percent_used)} used
                </span>
              </div>

              <div class="mb-2 truncate text-xs text-faint">
                ${this.escape(budget.client_name ?? 'No client')} · ${dateRange(budget)}
              </div>

              ${meter(budget)}

              <div class="mt-2 flex items-center justify-between gap-2 text-xs">
                <span class="tabular text-muted">
                  ${budgetDuration(budget, 'used_hours', 'used_seconds', { exact: budget.status === 'over' })}
                  / ${policyHours(budget.budgeted_hours)} hrs.
                </span>
                <span class="flex flex-shrink-0 items-center gap-1.5 text-right" style="color: var(--status-text)">
                  ${this.escape(headline(budget))}
                  ${icon ? insightIconInline(icon, 'Status breakdown') : ''}
                </span>
              </div>
            </a>
        `
    }

    /* ---- Failure ---- */

    showDisconnected() {
        const message = '<div class="tk-empty py-8">Can\'t reach the server. Reconnecting…</div>'
        setHtml(document.getElementById('summary-selection-clients'), message)
        setHtml(
            document.getElementById('summary-client-rows'),
            `<tr><td colspan="${SummaryDashboard.COLUMNS}">${message}</td></tr>`,
        )
    }
}

ready(() => new SummaryDashboard().init())
