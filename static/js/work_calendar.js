import { TimeKeeper, ready } from './base.js'
import { SaveChangesBar } from './save_changes.js'
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

class WorkCalendar extends TimeKeeper {
    constructor() {
        super()
        const now = new Date()
        this.month = new Date(now.getFullYear(), now.getMonth(), 1)
        this.today = isoDate(now)
        this.settings = null
        this.savedSettings = null
        this.draft = null
        this.loadIntent = 0
        this.days = new Map()
        this.selectionStart = null
        this.selectionEnd = null
        this.selectionWeekdays = null
        this.rangeAnchor = null
        this.editingId = null
        this.statusChoice = 'default'
        this.hoursChoice = 'default'

        this.grid = document.getElementById('work-calendar-grid')
        this.monthTitle = document.getElementById('calendar-month-title')
        this.monthCapacity = document.getElementById('calendar-month-capacity')
        this.dailyHours = document.getElementById('calendar-daily-hours')
        this.workdayGroup = document.getElementById('calendar-workdays')
        this.weekdayHeaders = document.getElementById('calendar-weekday-headers')
        this.selectionLabel = document.getElementById('calendar-selection-label')
        this.overrideFields = document.getElementById('calendar-override-fields')
        this.statusOptions = document.getElementById('calendar-status-options')
        this.hoursOptions = document.getElementById('calendar-hours-options')
        this.customHoursWrap = document.getElementById('calendar-custom-hours-wrap')
        this.customHours = document.getElementById('calendar-custom-hours')
        this.saveButton = document.getElementById('calendar-save-override')
        this.clearButton = document.getElementById('calendar-clear-selection')
        this.rules = document.getElementById('calendar-rules')
        this.ruleCount = document.getElementById('calendar-rule-count')
        this.saveBar = new SaveChangesBar({
            onSave: () => this.saveChanges(),
            onCancel: () => this.cancelChanges(),
        })
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
            this.statusChoice = button.dataset.status
            this.markEditorChoices()
        })
        this.hoursOptions.addEventListener('click', (event) => {
            const button = event.target.closest('[data-hours-mode]')
            if (!button) return
            this.hoursChoice = button.dataset.hoursMode
            this.markEditorChoices()
            if (this.hoursChoice === 'custom') this.customHours.focus()
        })
        this.saveButton.addEventListener('click', () => this.saveOverride())
    }

    async loadMonth({ resetDraft = false } = {}) {
        const start = startOfCalendar(this.month)
        const end = endOfCalendar(this.month)
        const intent = ++this.loadIntent
        this.monthTitle.textContent = MONTH_FORMAT.format(this.month)

        try {
            const endpoint = `/api/work-calendar?start=${isoDate(start)}&end=${isoDate(end)}`
            const payload = this.draft && !resetDraft
                ? await this.fetchFromAPI(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.draft),
                })
                : await this.fetchFromAPI(endpoint)
            if (intent !== this.loadIntent) return false

            if (!this.savedSettings || resetDraft) {
                this.savedSettings = this.settingsDraft(payload)
                this.draft = structuredClone(this.savedSettings)
                this.saveBar.setDirty(false)
            }
            this.settings = payload
            this.days = new Map(payload.days.map((day) => [day.date, day]))
            this.renderMonthCapacity(payload.days)
            this.renderDefaults()
            this.renderCalendar(start, end)
            this.renderRules()
            return true
        } catch (error) {
            if (intent !== this.loadIntent) return false
            this.grid.innerHTML = '<div class="tk-empty col-span-7 py-12">Could not load the work calendar.</div>'
            return false
        }
    }

    settingsDraft(payload) {
        return {
            work_hours_per_day: payload.work_hours_per_day,
            work_days: [...payload.work_days],
            work_calendar_overrides: structuredClone(payload.overrides),
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
            this.seedEditorFromDate(key)
        }
        this.updateSelectionEditor()
        this.renderCalendar(startOfCalendar(this.month), endOfCalendar(this.month))
    }

    seedEditorFromDate(key) {
        const details = this.days.get(key)
        if (!details) {
            this.statusChoice = 'default'
            this.hoursChoice = 'default'
            return
        }

        this.statusChoice = details.status_overridden
            ? details.is_workday ? 'work' : 'off'
            : 'default'
        this.hoursChoice = details.hours_overridden ? 'custom' : 'default'

        const configured = Number(details.configured_hours ?? details.default_hours)
        if (Number.isFinite(configured)) {
            this.customHours.value = String(Math.round(configured * 100) / 100)
        }
    }

    selectWeekday(weekday) {
        this.selectionStart = isoDate(new Date(this.month.getFullYear(), this.month.getMonth(), 1))
        this.selectionEnd = isoDate(new Date(this.month.getFullYear(), this.month.getMonth() + 1, 0))
        this.selectionWeekdays = [weekday]
        this.rangeAnchor = null
        this.editingId = null
        this.statusChoice = 'default'
        this.hoursChoice = 'default'
        this.updateSelectionEditor()
        this.renderCalendar(startOfCalendar(this.month), endOfCalendar(this.month))
    }

    clearSelection() {
        this.selectionStart = null
        this.selectionEnd = null
        this.selectionWeekdays = null
        this.rangeAnchor = null
        this.editingId = null
        this.statusChoice = 'default'
        this.hoursChoice = 'default'
        this.updateSelectionEditor()
        this.renderCalendar(startOfCalendar(this.month), endOfCalendar(this.month))
    }

    updateSelectionEditor() {
        const hasSelection = Boolean(this.selectionStart)
        this.overrideFields.disabled = !hasSelection
        this.saveButton.disabled = !hasSelection
        this.clearButton.disabled = !hasSelection
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
        this.saveButton.textContent = this.editingId ? 'Apply update' : 'Apply override'
        this.markEditorChoices()
    }

    markEditorChoices() {
        this.statusOptions.querySelectorAll('[data-status]').forEach((button) => {
            const selected = button.dataset.status === this.statusChoice
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
        })
        this.hoursOptions.querySelectorAll('[data-hours-mode]').forEach((button) => {
            const selected = button.dataset.hoursMode === this.hoursChoice
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
        })
        const custom = this.hoursChoice === 'custom'
        this.customHoursWrap.classList.toggle('hidden', !custom)
        this.customHoursWrap.classList.toggle('flex', custom)

        const resetting = Boolean(this.selectionStart)
            && this.statusChoice === 'default'
            && this.hoursChoice === 'default'
        this.saveButton.textContent = resetting
            ? 'Apply reset'
            : this.editingId ? 'Apply update' : 'Apply override'
    }

    async saveDailyHours() {
        const value = Number(this.dailyHours.value)
        if (!Number.isFinite(value) || value < 0.25 || value > 24) {
            this.dailyHours.value = String(this.draft.work_hours_per_day)
            this.showToast('Daily hours must be between 0.25 and 24.', 'error')
            return
        }
        await this.stageSettings({ work_hours_per_day: Math.round(value * 100) / 100 })
    }

    async toggleWorkday(weekday) {
        const next = this.draft.work_days.includes(weekday)
            ? this.draft.work_days.filter((day) => day !== weekday)
            : [...this.draft.work_days, weekday].sort((a, b) => a - b)
        if (!next.length) {
            this.showToast('Keep at least one usual workday.', 'warning')
            return
        }
        await this.stageSettings({ work_days: next })
    }

    async stageSettings(changes) {
        this.draft = { ...this.draft, ...structuredClone(changes) }
        this.updateDirtyState()
        return this.loadMonth()
    }

    async saveOverride() {
        if (!this.selectionStart) return
        const isWorkday = this.statusChoice === 'default' ? null : this.statusChoice === 'work'
        const resetWorkday = this.statusChoice === 'default'
        const resetHours = this.hoursChoice === 'default'
        let hours = null
        if (this.hoursChoice === 'custom') {
            hours = Number(this.customHours.value)
            if (!Number.isFinite(hours) || hours < 0.25 || hours > 24) {
                this.showToast('Daily hours must be between 0.25 and 24.', 'error')
                return
            }
            hours = Math.round(hours * 100) / 100
        }
        const rule = {
            id: this.editingId || this.makeId(),
            start_date: this.selectionStart,
            end_date: this.selectionEnd || this.selectionStart,
            weekdays: this.selectionWeekdays,
            is_workday: isWorkday,
            hours_per_day: hours,
            reset_workday: resetWorkday,
            reset_hours: resetHours,
        }
        const next = structuredClone(this.draft.work_calendar_overrides)
        const index = next.findIndex((item) => item.id === rule.id)
        if (index === -1) next.push(rule)
        else next[index] = rule

        this.saveButton.disabled = true
        const saved = await this.stageSettings({ work_calendar_overrides: next })
        this.saveButton.disabled = false
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
            remove.addEventListener('click', () => this.removeRule(rule))
            actions.append(edit, remove)
            row.append(content, actions)
            this.rules.appendChild(row)
        })
    }

    editRule(rule) {
        const start = localDate(rule.start_date)
        this.month = new Date(start.getFullYear(), start.getMonth(), 1)
        this.selectionStart = rule.start_date
        this.selectionEnd = rule.end_date
        this.selectionWeekdays = Array.isArray(rule.weekdays) ? [...rule.weekdays] : null
        this.rangeAnchor = this.selectionWeekdays === null ? rule.start_date : null
        this.editingId = rule.id
        this.statusChoice = rule.is_workday === null ? 'default' : rule.is_workday ? 'work' : 'off'
        this.hoursChoice = rule.hours_per_day === null ? 'default' : 'custom'
        if (rule.hours_per_day !== null) this.customHours.value = String(rule.hours_per_day)
        this.updateSelectionEditor()
        this.loadMonth().then(() => {
            document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
        })
    }

    updateDirtyState() {
        const dirty = JSON.stringify(this.draft) !== JSON.stringify(this.savedSettings)
        this.saveBar.setDirty(dirty)
    }

    async saveChanges() {
        try {
            const saved = await this.fetchFromAPI('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.draft),
            })
            this.savedSettings = {
                work_hours_per_day: saved.work_hours_per_day,
                work_days: [...saved.work_days],
                work_calendar_overrides: structuredClone(saved.work_calendar_overrides),
            }
            this.draft = structuredClone(this.savedSettings)
            await this.loadMonth({ resetDraft: true })
            this.showToast('Work calendar saved.')
            return true
        } catch (error) {
            return false
        }
    }

    async cancelChanges() {
        this.draft = structuredClone(this.savedSettings)
        const loaded = await this.loadMonth({ resetDraft: true })
        if (loaded) this.clearSelection()
        return loaded
    }

    async removeRule(rule) {
        if (!window.confirm(`Remove the override for ${this.formatRange(rule.start_date, rule.end_date)}?`)) return
        const next = this.draft.work_calendar_overrides.filter((item) => item.id !== rule.id)
        const saved = await this.stageSettings({ work_calendar_overrides: next })
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

    selectedDateCount() {
        if (!this.selectionStart) return 0
        const end = localDate(this.selectionEnd || this.selectionStart)
        let count = 0
        for (let day = localDate(this.selectionStart); day <= end; day = addDays(day, 1)) {
            if (this.selectionWeekdays === null || this.selectionWeekdays.includes(isoWeekday(day))) {
                count++
            }
        }
        return count
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
