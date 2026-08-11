import { TimeKeeper, confirmAction, disarmConfirm, ready } from './base.js'
import { daysSinceWeekStart, isoWeekday } from './week_start.js'

const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const RANGE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function localDate(value) {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year, month - 1, day)
}

function isoDate(value) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function addDays(value, amount) {
    const next = new Date(value.getFullYear(), value.getMonth(), value.getDate())
    next.setDate(next.getDate() + amount)
    return next
}

/* The grid always renders whole weeks, so it runs from the start of the week
   containing the 1st to the end of the week containing the last day. Which
   weekday that is depends on the week-start preference; the weekday *numbers*
   used everywhere else remain ISO. */
function startOfCalendar(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1)
    return addDays(first, -daysSinceWeekStart(first))
}

function endOfCalendar(month) {
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0)
    return addDays(last, 6 - daysSinceWeekStart(last))
}

/**
 * Every edit on this page is written straight through to the settings file.
 *
 * The page used to stage a draft behind the shared "Unsaved changes" bar, which
 * meant two confirmations for one intent: Apply override, then Save changes.
 * The editor's own Apply button is the deliberate step, so there is nothing
 * left for a second one to protect — and no draft state to strand if the user
 * navigates away mid-edit.
 */
class WorkCalendar extends TimeKeeper {
    constructor() {
        super()
        const now = new Date()
        this.month = new Date(now.getFullYear(), now.getMonth(), 1)
        this.today = isoDate(now)
        this.settings = null
        this.loadIntent = 0
        this.days = new Map()
        this.selectionStart = null
        this.selectionEnd = null
        this.selectionWeekdays = null
        this.rangeAnchor = null
        this.editingId = null
        // true / false / null, where null is "the selected dates don't agree,
        // so leave each one's status alone".
        this.statusChoice = null
        this.seeded = { status: null, hours: null }

        this.grid = document.getElementById('work-calendar-grid')
        this.monthTitle = document.getElementById('calendar-month-title')
        this.monthCapacity = document.getElementById('calendar-month-capacity')
        this.dailyHours = document.getElementById('calendar-daily-hours')
        this.workdayGroup = document.getElementById('calendar-workdays')
        this.weekdayHeaders = document.getElementById('calendar-weekday-headers')
        this.selectionLabel = document.getElementById('calendar-selection-label')
        this.overrideFields = document.getElementById('calendar-override-fields')
        this.statusOptions = document.getElementById('calendar-status-options')
        this.customHours = document.getElementById('calendar-custom-hours')
        this.editorHint = document.getElementById('calendar-editor-hint')
        this.saveButton = document.getElementById('calendar-save-override')
        this.resetButton = document.getElementById('calendar-reset-override')
        this.clearButton = document.getElementById('calendar-clear-selection')
        this.rules = document.getElementById('calendar-rules')
        this.ruleCount = document.getElementById('calendar-rule-count')
    }

    async init() {
        this.bindEvents()
        this.markEditorChoices()
        await this.loadMonth()
    }

    bindEvents() {
        document.getElementById('calendar-previous').addEventListener('click', () => this.changeMonth(-1))
        document.getElementById('calendar-next').addEventListener('click', () => this.changeMonth(1))
        document.getElementById('calendar-today').addEventListener('click', () => {
            const now = new Date()
            this.month = new Date(now.getFullYear(), now.getMonth(), 1)
            this.loadMonth()
        })
        this.clearButton.addEventListener('click', () => this.clearSelection())

        this.dailyHours.addEventListener('change', () => this.saveDailyHours())
        this.dailyHours.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') this.dailyHours.blur()
        })
        this.workdayGroup.addEventListener('click', (event) => {
            const button = event.target.closest('[data-weekday]')
            if (button) this.toggleWorkday(Number(button.dataset.weekday))
        })
        this.weekdayHeaders.addEventListener('click', (event) => {
            const button = event.target.closest('[data-calendar-weekday]')
            if (button) this.selectWeekday(Number(button.dataset.calendarWeekday))
        })

        this.statusOptions.addEventListener('click', (event) => {
            const button = event.target.closest('[data-status]')
            if (!button) return
            this.statusChoice = button.dataset.status === 'work'
            this.markEditorChoices()
        })
        // Typing an amount is itself the override, so the hints and the Apply
        // label have to follow every keystroke rather than waiting for change.
        this.customHours.addEventListener('input', () => this.markEditorChoices())
        this.saveButton.addEventListener('click', () => this.saveOverride())
        // A reset can clear several rules at once — more than the per-rule
        // Remove does — so it takes the same second click Remove does.
        this.resetButton.addEventListener('click', () => {
            confirmAction(this.resetButton, () => this.resetSelection(), { label: 'Confirm reset?' })
        })
    }

    async loadMonth() {
        const start = startOfCalendar(this.month)
        const end = endOfCalendar(this.month)
        const intent = ++this.loadIntent
        this.monthTitle.textContent = MONTH_FORMAT.format(this.month)

        try {
            const payload = await this.fetchFromAPI(
                `/api/work-calendar?start=${isoDate(start)}&end=${isoDate(end)}`
            )
            if (intent !== this.loadIntent) return false

            this.settings = payload
            this.days = new Map(payload.days.map((day) => [day.date, day]))
            this.renderMonthCapacity(payload.days)
            this.renderDefaults()
            this.renderCalendar(start, end)
            this.renderRules()
            // Fresh data can change what the editor says about the selection —
            // whether there is anything left to reset, most of all. It re-reads
            // the controls without re-seeding them, so anything typed survives.
            this.updateSelectionEditor()
            return true
        } catch (error) {
            if (intent !== this.loadIntent) return false
            this.grid.innerHTML = '<div class="tk-empty col-span-7 py-12">Could not load the work calendar.</div>'
            return false
        }
    }

    renderDefaults() {
        this.dailyHours.disabled = false
        if (document.activeElement !== this.dailyHours) {
            this.dailyHours.value = String(this.settings.work_hours_per_day)
        }
        this.workdayGroup.querySelectorAll('[data-weekday]').forEach((button) => {
            button.disabled = false
            const selected = this.settings.work_days.includes(Number(button.dataset.weekday))
            button.classList.toggle('active', selected)
            button.setAttribute('aria-pressed', selected ? 'true' : 'false')
        })
    }

    renderMonthCapacity(days) {
        const inMonth = days.filter((day) => {
            const value = localDate(day.date)
            return value.getMonth() === this.month.getMonth()
                && value.getFullYear() === this.month.getFullYear()
        })
        const hours = inMonth.reduce((total, day) => total + day.hours, 0)
        const workdays = inMonth.filter((day) => day.is_workday).length
        const label = workdays === 1 ? 'workday' : 'workdays'
        this.monthCapacity.textContent = `${hours.toFixed(2).replace(/\.00$/, '')} hrs · ${workdays} ${label}`
    }

    renderCalendar(start, end) {
        this.renderWeekdayHeaders()
        this.grid.replaceChildren()
        for (let day = start; day <= end; day = addDays(day, 1)) {
            const key = isoDate(day)
            const details = this.days.get(key)
            const button = document.createElement('button')
            const outside = day.getMonth() !== this.month.getMonth()
            const selected = this.isSelected(key)
            const overridden = details?.status_overridden || details?.hours_overridden
            button.type = 'button'
            button.className = 'tk-work-calendar-day'
            button.classList.toggle('is-outside', outside)
            button.classList.toggle('is-off', details && !details.is_workday)
            button.classList.toggle('is-selected', selected)
            button.classList.toggle('is-today', key === this.today)
            button.dataset.date = key
            button.setAttribute('role', 'gridcell')

            const number = document.createElement('span')
            number.className = 'tk-calendar-date-number'
            number.textContent = String(day.getDate())
            const capacity = document.createElement('span')
            capacity.className = 'tk-calendar-capacity tabular'
            capacity.textContent = details?.is_workday ? `${details.hours.toFixed(2).replace(/\.00$/, '')}h` : 'Off'
            const capacityRow = document.createElement('span')
            capacityRow.className = 'tk-calendar-capacity-row'
            capacityRow.appendChild(capacity)
            button.appendChild(number)

            if (overridden) {
                const badge = document.createElement('span')
                badge.className = 'tk-calendar-override-label'
                badge.textContent = 'Override'
                capacityRow.appendChild(badge)
            }

            button.appendChild(capacityRow)

            const accessible = `${RANGE_FORMAT.format(day)}: ${capacity.textContent}${overridden ? ', overridden' : ''}`
            button.setAttribute('aria-label', accessible)
            button.addEventListener('click', (event) => this.selectDate(key, event.shiftKey))
            this.grid.appendChild(button)
        }
    }

    isSelected(key) {
        if (!this.selectionStart) return false
        const end = this.selectionEnd || this.selectionStart
        if (key < this.selectionStart || key > end) return false
        if (this.selectionWeekdays === null) return true
        return this.selectionWeekdays.includes(isoWeekday(localDate(key)))
    }

    renderWeekdayHeaders() {
        this.weekdayHeaders.querySelectorAll('[data-calendar-weekday]').forEach((button) => {
            const selected = this.selectionWeekdays?.includes(
                Number(button.dataset.calendarWeekday)
            ) || false
            button.classList.toggle('active', selected)
            button.setAttribute('aria-pressed', selected ? 'true' : 'false')
        })
    }

    selectDate(key, shiftHeld = false) {
        const canExtendRange = shiftHeld
            && this.rangeAnchor !== null
            && this.selectionWeekdays === null

        if (canExtendRange) {
            if (key === this.rangeAnchor) {
                this.selectionStart = this.rangeAnchor
                this.selectionEnd = null
            } else if (key < this.rangeAnchor) {
                this.selectionStart = key
                this.selectionEnd = this.rangeAnchor
            } else {
                this.selectionStart = this.rangeAnchor
                this.selectionEnd = key
            }
        } else {
            // A normal click always starts a fresh single-day selection. This
            // keeps inspecting adjacent dates from accidentally turning into
            // a range; Shift is the explicit range gesture.
            this.selectionStart = key
            this.selectionEnd = null
            this.selectionWeekdays = null
            this.rangeAnchor = key
            this.editingId = null
        }
        // Re-seeded on every selection change, extensions included: adding a
        // Saturday to a weekday range can turn a settled status into a mixed one.
        this.seedEditorFromSelection()
        this.updateSelectionEditor()
        this.renderCalendar(startOfCalendar(this.month), endOfCalendar(this.month))
    }

    /**
     * What the selected dates currently look like, per editable field.
     *
     * `default` is what the recurring schedule alone gives, `effective` is what
     * the date resolves to today including any override. Either is `null` when
     * the selected dates disagree — a Monday-to-Sunday range has two different
     * default statuses, and there is no single value to seed or compare with.
     *
     * Only dates in the loaded window are considered. A selection can outrun it
     * (a saved rule may span months), and the visible part is what the editor
     * is describing.
     */
    selectionSummary() {
        const details = this.selectedDateKeys()
            .map((key) => this.days.get(key))
            .filter(Boolean)

        const only = (values) => {
            const unique = [...new Set(values)]
            return unique.length === 1 ? unique[0] : null
        }
        // Rounded to the same 2dp the input and the settings file use, so a
        // stored 6.67 and a typed 6.67 compare equal rather than reading as an
        // override of themselves.
        const hours = (value) => Math.round(Number(value) * 100) / 100

        const statusEffective = only(details.map((day) => day.is_workday))
        const hoursEffective = only(details.map((day) => hours(day.configured_hours ?? day.default_hours)))

        return {
            count: details.length,
            statusDefault: only(details.map((day) => day.default_is_workday)),
            statusEffective,
            hoursDefault: only(details.map((day) => hours(day.default_hours))),
            hoursEffective,
            // A range holding both working and non-working days has no single
            // "hours per working day" to show — the off days aren't working
            // days at all — so the box starts blank there as well.
            hoursSeed: statusEffective === null ? null : hoursEffective,
            statusOverridden: details.some((day) => day.status_overridden),
            hoursOverridden: details.some((day) => day.hours_overridden),
        }
    }

    /** Show the selection as it stands. Nothing here is an override yet. */
    seedEditorFromSelection() {
        const summary = this.selectionSummary()
        this.statusChoice = summary.statusEffective
        this.customHours.value = summary.hoursSeed === null ? '' : String(summary.hoursSeed)
        // Kept so Apply can tell "I chose this" from "this is just what was
        // already here". Re-applying the value a date already resolves to would
        // otherwise duplicate the rule that produced it.
        this.seeded = { status: this.statusChoice, hours: this.chosenHours() }
    }

    /**
     * What Apply would do to one field, from the value in the editor alone:
     *
     *   skip     — no value chosen; the selection was mixed and left alone
     *   match    — the value is the default and nothing overrides it: no rule
     *   reset    — the value is the default but an override exists: clear it
     *   override — the value differs from the default, so it is recorded
     *
     * A chosen value against mixed defaults is an override: it differs from at
     * least one of the dates, and the user picked it deliberately for all.
     */
    fieldPlan(chosen, defaultValue, overridden) {
        if (chosen === null) return { action: 'skip', value: null }
        if (defaultValue !== null && chosen === defaultValue) {
            return { action: overridden ? 'reset' : 'match', value: null }
        }
        return { action: 'override', value: chosen }
    }

    /** The chosen hours, or null for an empty box; NaN for an unusable entry. */
    chosenHours() {
        const raw = this.customHours.value.trim()
        if (!raw) return null
        const value = Number(raw)
        if (!Number.isFinite(value)) return NaN
        return Math.round(value * 100) / 100
    }

    /** Both field plans, plus whether applying them would record anything. */
    editorPlan() {
        const summary = this.selectionSummary()
        const hours = this.chosenHours()
        const status = this.fieldPlan(this.statusChoice, summary.statusDefault, summary.statusOverridden)
        const hoursPlan = Number.isNaN(hours)
            ? { action: 'skip', value: null }
            : this.fieldPlan(hours, summary.hoursDefault, summary.hoursOverridden)

        // Nothing has been touched, so whatever the editor shows is just what
        // the dates already are. Applying it would restate an existing rule.
        const touched = this.statusChoice !== this.seeded.status
            || !Object.is(hours, this.seeded.hours)
        const records = (plan) => plan.action === 'override' || plan.action === 'reset'

        return {
            summary,
            status,
            hours: hoursPlan,
            overrides: status.action === 'override' || hoursPlan.action === 'override',
            writes: touched && (records(status) || records(hoursPlan)),
        }
    }

    selectWeekday(weekday) {
        this.selectionStart = isoDate(new Date(this.month.getFullYear(), this.month.getMonth(), 1))
        this.selectionEnd = isoDate(new Date(this.month.getFullYear(), this.month.getMonth() + 1, 0))
        this.selectionWeekdays = [weekday]
        this.rangeAnchor = null
        this.editingId = null
        this.seedEditorFromSelection()
        this.updateSelectionEditor()
        this.renderCalendar(startOfCalendar(this.month), endOfCalendar(this.month))
    }

    clearSelection() {
        this.selectionStart = null
        this.selectionEnd = null
        this.selectionWeekdays = null
        this.rangeAnchor = null
        this.editingId = null
        this.statusChoice = null
        this.customHours.value = ''
        this.seeded = { status: null, hours: null }
        this.updateSelectionEditor()
        this.renderCalendar(startOfCalendar(this.month), endOfCalendar(this.month))
    }

    updateSelectionEditor() {
        const hasSelection = Boolean(this.selectionStart)
        this.overrideFields.disabled = !hasSelection
        this.saveButton.disabled = !hasSelection
        this.clearButton.disabled = !hasSelection
        // Nothing to reset unless a stored rule actually reaches these dates.
        const resettable = hasSelection
            && (this.settings?.overrides || []).some((rule) => this.ruleTouchesSelection(rule))
        if (!resettable) disarmConfirm(this.resetButton)
        this.resetButton.disabled = !resettable
        if (!hasSelection) {
            this.selectionLabel.textContent = 'Select a date on the calendar.'
        } else if (this.selectionWeekdays !== null) {
            const names = this.selectionWeekdays.map((day) => `${WEEKDAY_NAMES[day]}s`)
            const count = this.selectedDateCount()
            this.selectionLabel.textContent = `${names.join(', ')} in ${this.formatSpan(this.selectionStart, this.selectionEnd)} · ${count} dates`
        } else {
            const end = this.selectionEnd || this.selectionStart
            this.selectionLabel.textContent = this.formatRange(this.selectionStart, end)
        }
        this.markEditorChoices()
    }

    markEditorChoices() {
        this.statusOptions.querySelectorAll('[data-status]').forEach((button) => {
            // Neither segment lights up while statusChoice is null, which is
            // what "mixed, left alone" looks like.
            const selected = (button.dataset.status === 'work') === this.statusChoice
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
        })

        if (!this.selectionStart) {
            this.customHours.placeholder = ''
            this.setEditorHint('')
            this.saveButton.textContent = 'Apply override'
            return
        }

        const plan = this.editorPlan()
        // The placeholder is the whole explanation for a blank box: these dates
        // disagree, and leaving it alone keeps each one as it is.
        this.customHours.placeholder = plan.summary.hoursSeed === null ? 'Mixed' : ''
        this.setEditorHint(
            Number.isNaN(this.chosenHours()) ? 'Enter an amount between 0.25 and 24.' : ''
        )

        this.saveButton.textContent = !plan.writes
            ? 'Apply'
            : plan.overrides
                ? this.editingId ? 'Apply update' : 'Apply override'
                : 'Apply reset'
    }

    /* Hidden rather than left empty, so the card doesn't keep a gap where a
       hint would go. `hidden` is toggled from here instead of a CSS `:empty`
       rule because the stylesheet is a build artifact. */
    setEditorHint(text) {
        this.editorHint.textContent = text
        this.editorHint.classList.toggle('hidden', !text)
    }

    async saveDailyHours() {
        const value = Number(this.dailyHours.value)
        if (!Number.isFinite(value) || value < 0.25 || value > 24) {
            this.dailyHours.value = String(this.settings.work_hours_per_day)
            this.showToast('Daily hours must be between 0.25 and 24.', 'error')
            return
        }
        // No toast here or in toggleWorkday: both controls repaint every day in
        // the grid, which is louder confirmation than a toast, and workdays get
        // toggled several times in a row.
        await this.commitSettings({ work_hours_per_day: Math.round(value * 100) / 100 })
    }

    async toggleWorkday(weekday) {
        const next = this.settings.work_days.includes(weekday)
            ? this.settings.work_days.filter((day) => day !== weekday)
            : [...this.settings.work_days, weekday].sort((a, b) => a - b)
        if (!next.length) {
            this.showToast('Keep at least one usual workday.', 'warning')
            return
        }
        await this.commitSettings({ work_days: next })
    }

    /**
     * Write `changes` to the settings file and repaint from what came back.
     *
     * The reload is a plain GET of the saved state, so the grid can never show
     * a value the server didn't accept. A rejected write leaves the file alone
     * and fetchFromAPI has already toasted the reason; reloading anyway puts
     * the controls back in step with what is actually stored.
     */
    async commitSettings(changes, message) {
        try {
            await this.fetchFromAPI('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(changes),
            })
        } catch (error) {
            await this.loadMonth()
            return false
        }
        const loaded = await this.loadMonth()
        if (loaded && message) this.showToast(message)
        return loaded
    }

    async saveOverride() {
        if (!this.selectionStart) return

        const hours = this.chosenHours()
        if (Number.isNaN(hours) || (hours !== null && (hours < 0.25 || hours > 24))) {
            this.showToast('Daily hours must be between 0.25 and 24.', 'error')
            return
        }

        const plan = this.editorPlan()
        if (!plan.writes) {
            this.showToast('Nothing to change — the selection already reads this way.', 'info')
            return
        }

        const next = structuredClone(this.settings.overrides)
        const rule = {
            id: this.editingId || this.makeId(),
            start_date: this.selectionStart,
            end_date: this.selectionEnd || this.selectionStart,
            weekdays: this.selectionWeekdays,
            is_workday: plan.status.action === 'override' ? plan.status.value : null,
            hours_per_day: plan.hours.action === 'override' ? plan.hours.value : null,
            reset_workday: plan.status.action === 'reset',
            reset_hours: plan.hours.action === 'reset',
        }
        const index = next.findIndex((item) => item.id === rule.id)
        if (index === -1) next.push(rule)
        else next[index] = rule

        this.saveButton.disabled = true
        const saved = await this.commitSettings(
            { work_calendar_overrides: next },
            this.editingId
                ? 'Override updated.'
                : plan.overrides ? 'Override applied.' : 'Reset to defaults.'
        )
        this.saveButton.disabled = false
        if (saved) this.clearSelection()
    }

    /** Does this rule reach any of the dates the selection covers? */
    ruleTouchesSelection(rule) {
        if (!this.selectionStart) return false
        const end = this.selectionEnd || this.selectionStart
        if (rule.end_date < this.selectionStart || rule.start_date > end) return false
        if (rule.weekdays === null || this.selectionWeekdays === null) return true
        return rule.weekdays.some((day) => this.selectionWeekdays.includes(day))
    }

    /**
     * Clear both fields back to the schedule defaults across the selection.
     *
     * Rules are ordered rather than addressable, so "reset" normally means
     * appending a rule that resets both fields. Where the selection swallows a
     * rule whole — same range or wider, and no weekday filter narrowing it —
     * that rule can never apply again, so it is dropped instead of buried. If
     * dropping them leaves nothing reaching the selection, no reset rule is
     * needed at all and the list simply gets shorter.
     */
    async resetSelection() {
        if (!this.selectionStart) return
        const start = this.selectionStart
        const end = this.selectionEnd || start

        const swallowed = (rule) => this.selectionWeekdays === null
            && rule.start_date >= start
            && rule.end_date <= end

        const remaining = structuredClone(this.settings.overrides).filter((rule) => !swallowed(rule))
        const next = remaining.some((rule) => this.ruleTouchesSelection(rule))
            ? [...remaining, {
                id: this.makeId(),
                start_date: start,
                end_date: end,
                weekdays: this.selectionWeekdays,
                is_workday: null,
                hours_per_day: null,
                reset_workday: true,
                reset_hours: true,
            }]
            : remaining

        this.resetButton.disabled = true
        const saved = await this.commitSettings(
            { work_calendar_overrides: next },
            'Reset to the schedule defaults.'
        )
        this.resetButton.disabled = false
        if (saved) this.clearSelection()
    }

    makeId() {
        if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
        return `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`
    }

    renderRules() {
        // The stored rule list includes reset and superseded rules needed to
        // resolve precedence. Only list rules that currently produce a visible
        // override in the displayed month, so this section agrees with the
        // calendar rather than exposing implementation history.
        const activeRuleIds = new Set(
            [...this.days.values()]
                .filter((day) => {
                    const value = localDate(day.date)
                    return value.getMonth() === this.month.getMonth()
                        && value.getFullYear() === this.month.getFullYear()
                })
                .flatMap((day) => day.active_rule_ids || [])
        )
        const overrides = this.settings.overrides.filter((rule) => activeRuleIds.has(rule.id))
        this.ruleCount.textContent = String(overrides.length)
        if (!overrides.length) {
            this.rules.innerHTML = '<div class="tk-empty py-8">No effective overrides this month.</div>'
            return
        }

        this.rules.replaceChildren()
        overrides.forEach((rule, index) => {
            const row = document.createElement('div')
            row.className = 'flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between'
            const content = document.createElement('div')
            const title = document.createElement('p')
            title.className = 'text-sm font-medium text-text'
            title.textContent = this.formatRange(rule.start_date, rule.end_date)
            const description = document.createElement('p')
            description.className = 'mt-1 text-xs text-muted'
            const parts = []
            if (rule.weekdays !== null) {
                parts.push(`${rule.weekdays.map((day) => `${WEEKDAY_NAMES[day]}s`).join(', ')} only`)
            }
            if (rule.reset_workday && rule.reset_hours) {
                parts.push('Reset to schedule defaults')
            } else {
                if (rule.reset_workday) parts.push('Default work status')
                if (rule.reset_hours) parts.push('Default daily hours')
            }
            if (rule.is_workday === true) parts.push('Working days')
            if (rule.is_workday === false) parts.push('Non-working days')
            if (rule.hours_per_day !== null) parts.push(`${rule.hours_per_day} hrs per working day`)
            description.textContent = `${index + 1}. ${parts.join(' · ')}`
            content.append(title, description)

            const actions = document.createElement('div')
            actions.className = 'flex flex-shrink-0 gap-2'
            const edit = document.createElement('button')
            edit.type = 'button'
            edit.className = 'tk-btn tk-btn-secondary'
            edit.textContent = 'Edit'
            edit.addEventListener('click', () => this.editRule(rule))
            const remove = document.createElement('button')
            remove.type = 'button'
            remove.className = 'tk-btn tk-btn-ghost text-danger'
            remove.textContent = 'Remove'
            // Removing a rule has no Apply step of its own, so it keeps the
            // app's standard second click rather than a native confirm().
            remove.addEventListener('click', () => confirmAction(remove, () => this.removeRule(rule)))
            actions.append(edit, remove)
            row.append(content, actions)
            this.rules.appendChild(row)
        })
    }

    /**
     * Editing selects the rule's range and then seeds from the dates like any
     * other selection, rather than from the rule's own fields. What the range
     * resolves to now is what the editor should show — and it's what Apply will
     * be compared against, so the two can't disagree.
     */
    editRule(rule) {
        const start = localDate(rule.start_date)
        this.month = new Date(start.getFullYear(), start.getMonth(), 1)
        this.selectionStart = rule.start_date
        this.selectionEnd = rule.end_date
        this.selectionWeekdays = Array.isArray(rule.weekdays) ? [...rule.weekdays] : null
        this.rangeAnchor = this.selectionWeekdays === null ? rule.start_date : null
        this.editingId = rule.id
        // Seeded after the load, since the dates being described may be in a
        // month that isn't in `this.days` yet.
        this.loadMonth().then(() => {
            this.seedEditorFromSelection()
            this.updateSelectionEditor()
            document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
        })
    }

    async removeRule(rule) {
        const next = this.settings.overrides.filter((item) => item.id !== rule.id)
        const saved = await this.commitSettings(
            { work_calendar_overrides: next },
            'Override removed.'
        )
        if (saved && this.editingId === rule.id) this.clearSelection()
    }

    changeMonth(amount) {
        if (this.selectionWeekdays !== null) {
            this.selectionStart = null
            this.selectionEnd = null
            this.selectionWeekdays = null
            this.rangeAnchor = null
            this.editingId = null
            this.updateSelectionEditor()
        }
        this.month = new Date(this.month.getFullYear(), this.month.getMonth() + amount, 1)
        this.loadMonth()
    }

    /** ISO dates the current selection covers, weekday filter applied. */
    selectedDateKeys() {
        if (!this.selectionStart) return []
        const end = localDate(this.selectionEnd || this.selectionStart)
        const keys = []
        for (let day = localDate(this.selectionStart); day <= end; day = addDays(day, 1)) {
            if (this.selectionWeekdays === null || this.selectionWeekdays.includes(isoWeekday(day))) {
                keys.push(isoDate(day))
            }
        }
        return keys
    }

    selectedDateCount() {
        return this.selectedDateKeys().length
    }

    formatRange(start, end) {
        if (start === end) return RANGE_FORMAT.format(localDate(start))
        return `${RANGE_FORMAT.format(localDate(start))} – ${RANGE_FORMAT.format(localDate(end))}`
    }

    /* Clicking a weekday heading always selects the whole visible month, and
       "Thursdays in August 2026" reads better there than repeating both
       endpoints. A saved rule can span any dates, so anything that isn't
       exactly one calendar month falls back to the range. */
    formatSpan(start, end) {
        const from = localDate(start)
        const to = localDate(end || start)
        const lastOfMonth = new Date(to.getFullYear(), to.getMonth() + 1, 0).getDate()
        const wholeMonth =
            from.getDate() === 1
            && to.getDate() === lastOfMonth
            && from.getFullYear() === to.getFullYear()
            && from.getMonth() === to.getMonth()
        return wholeMonth ? MONTH_FORMAT.format(from) : this.formatRange(start, end || start)
    }
}

ready(() => new WorkCalendar().init())
