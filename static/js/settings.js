import { TimeKeeper, ready } from './base.js'
import { applyTheme, currentMode } from './theme.js'
import { applyTimeFormat, currentTimeFormat } from './time_format.js'
import { SaveChangesBar } from './save_changes.js'

/**
 * Settings page.
 *
 * Each control updates a local draft. The floating save/cancel bar is the only
 * path that writes settings, so the UI can be previewed and then confirmed or
 * restored as one change set.
 *
 * Nothing here fetches the current settings: every control is rendered at its
 * stored value by Jinja, so the page is already correct before this module
 * evaluates. What we keep instead is `saved` — the last value the *server*
 * confirmed — which is what a failed write rolls back to.
 */

const INTERVAL_PRESETS = [15, 30, 60]
const ROUNDING_INTERVAL_PRESETS = [5, 10, 15, 30, 60]

class Settings extends TimeKeeper {
    constructor() {
        super()
        this.themeGroup = document.getElementById('theme-mode')
        this.timeFormatGroup = document.getElementById('time-format')

        this.roundingToggle = document.getElementById('rounding-enabled')
        this.roundingOptions = document.getElementById('rounding-options')
        this.roundingIntervalGroup = document.getElementById('rounding-interval')
        this.roundingIntervalCustom = document.getElementById('rounding-interval-custom')
        this.roundingIntervalInput = document.getElementById('rounding-interval-input')
        this.roundingDirectionGroup = document.getElementById('rounding-direction')

        this.reminderToggle = document.getElementById('reminder-enabled')
        this.reminderOptions = document.getElementById('reminder-options')
        this.intervalGroup = document.getElementById('reminder-interval')
        this.intervalCustom = document.getElementById('reminder-interval-custom')
        this.intervalInput = document.getElementById('reminder-interval-input')
        this.snoozeInput = document.getElementById('reminder-snooze-input')

        // Dev-only; absent in a packaged build.
        this.testButton = document.getElementById('reminder-test')
        this.statusList = document.getElementById('reminder-status')

        // Last server-confirmed values, seeded from what the server rendered.
        this.saved = {
            theme: currentMode(),
            time_format: currentTimeFormat(),
            rounding_enabled: this.roundingToggle.getAttribute('aria-checked') === 'true',
            rounding_interval_minutes: Number(this.roundingIntervalInput.value),
            rounding_direction: document.documentElement.dataset.roundingDirection,
            reminder_enabled: this.reminderToggle.getAttribute('aria-checked') === 'true',
            reminder_interval_minutes: Number(this.intervalInput.value),
            reminder_snooze_minutes: Number(this.snoozeInput.value),
        }
        this.draft = { ...this.saved }
        this.saveBar = new SaveChangesBar({
            onSave: () => this.saveChanges(),
            onCancel: () => this.cancelChanges(),
        })
    }

    init() {
        this.initTheme()
        this.initTimeFormat()
        this.initRounding()
        this.initReminders()
        this.initDevTools()
    }

    // -- theme -------------------------------------------------------------

    initTheme() {
        // The server already rendered the stored mode onto <html>; read it from
        // there rather than fetching it back.
        this.markThemeSelected(currentMode())

        this.themeGroup.addEventListener('click', (event) => {
            const button = event.target.closest('[data-theme-option]')
            if (!button) return
            this.setTheme(button.dataset.themeOption)
        })

        // Arrow keys across a radiogroup, as expected for this role.
        this.themeGroup.addEventListener('keydown', (event) => {
            if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
            const options = [...this.themeGroup.querySelectorAll('[data-theme-option]')]
            const index = options.findIndex((b) => b.dataset.themeOption === currentMode())
            const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
            const next = options[(index + step + options.length) % options.length]
            event.preventDefault()
            next.focus()
            this.setTheme(next.dataset.themeOption)
        })
    }

    /** Reflect `mode` in the segmented control. */
    markThemeSelected(mode) {
        this.themeGroup.querySelectorAll('[data-theme-option]').forEach((button) => {
            const selected = button.dataset.themeOption === mode
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
            // Only the selected option stays in the tab order, per radiogroup
            // convention — arrow keys move between them.
            button.tabIndex = selected ? 0 : -1
        })
    }

    setTheme(mode) {
        if (mode === currentMode()) return
        applyTheme(mode)
        this.markThemeSelected(mode)
        this.stage('theme', mode)
    }

    // -- time format ------------------------------------------------------

    initTimeFormat() {
        this.markTimeFormatSelected(currentTimeFormat())

        this.timeFormatGroup.addEventListener('click', (event) => {
            const button = event.target.closest('[data-time-format-option]')
            if (!button) return
            this.setTimeFormat(button.dataset.timeFormatOption)
        })

        this.timeFormatGroup.addEventListener('keydown', (event) => {
            if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
            const options = [
                ...this.timeFormatGroup.querySelectorAll('[data-time-format-option]'),
            ]
            const index = options.findIndex(
                (button) => button.dataset.timeFormatOption === currentTimeFormat()
            )
            const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
            const next = options[(index + step + options.length) % options.length]
            event.preventDefault()
            next.focus()
            this.setTimeFormat(next.dataset.timeFormatOption)
        })
    }

    markTimeFormatSelected(timeFormat) {
        this.timeFormatGroup.querySelectorAll('[data-time-format-option]').forEach((button) => {
            const selected = button.dataset.timeFormatOption === timeFormat
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
            button.tabIndex = selected ? 0 : -1
        })
    }

    setTimeFormat(timeFormat) {
        if (timeFormat === currentTimeFormat()) return
        applyTimeFormat(timeFormat)
        this.markTimeFormatSelected(timeFormat)
        this.stage('time_format', timeFormat)
    }

    // -- rounding ---------------------------------------------------------

    initRounding() {
        this.markRoundingEnabled(this.saved.rounding_enabled)
        this.markRoundingInterval(this.saved.rounding_interval_minutes)
        this.markRoundingDirection(this.saved.rounding_direction)

        this.roundingToggle.addEventListener('click', () => this.toggleRounding())
        this.roundingIntervalGroup.addEventListener('click', (event) => {
            const button = event.target.closest('[data-rounding-interval]')
            if (button) this.chooseRoundingInterval(button.dataset.roundingInterval)
        })
        this.roundingDirectionGroup.addEventListener('click', (event) => {
            const button = event.target.closest('[data-rounding-direction]')
            if (button) this.setRoundingDirection(button.dataset.roundingDirection)
        })
        this.bindRoundingDirectionKeys()

        this.bindNumberField(
            this.roundingIntervalInput,
            'rounding_interval_minutes',
            (value) => this.markRoundingInterval(value)
        )
    }

    toggleRounding() {
        const enabled = !(this.roundingToggle.getAttribute('aria-checked') === 'true')
        this.markRoundingEnabled(enabled)
        this.stage('rounding_enabled', enabled)
    }

    markRoundingEnabled(enabled) {
        this.roundingToggle.setAttribute('aria-checked', enabled ? 'true' : 'false')
        this.roundingOptions.dataset.active = enabled ? 'true' : 'false'
    }

    chooseRoundingInterval(choice) {
        if (choice === 'custom') {
            this.markRoundingInterval(null)
            this.roundingIntervalInput.focus()
            this.roundingIntervalInput.select()
            return
        }

        const minutes = Number(choice)
        this.roundingIntervalInput.value = String(minutes)
        this.markRoundingInterval(minutes)
        this.commit('rounding_interval_minutes', minutes, this.roundingIntervalInput)
    }

    markRoundingInterval(minutes) {
        const isPreset = minutes !== null && ROUNDING_INTERVAL_PRESETS.includes(minutes)
        const active = isPreset ? String(minutes) : 'custom'

        this.roundingIntervalGroup.querySelectorAll('[data-rounding-interval]').forEach((button) => {
            const selected = button.dataset.roundingInterval === active
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
            button.tabIndex = selected ? 0 : -1
        })

        this.roundingIntervalCustom.classList.toggle('hidden', isPreset)
        this.roundingIntervalCustom.classList.toggle('flex', !isPreset)
    }

    markRoundingDirection(direction) {
        this.roundingDirectionGroup.querySelectorAll('[data-rounding-direction]').forEach((button) => {
            const selected = button.dataset.roundingDirection === direction
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
            button.tabIndex = selected ? 0 : -1
        })
    }

    setRoundingDirection(direction) {
        if (direction === this.draft.rounding_direction) return
        this.markRoundingDirection(direction)
        this.stage('rounding_direction', direction)
    }

    bindRoundingDirectionKeys() {
        this.roundingDirectionGroup.addEventListener('keydown', (event) => {
            if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
            const options = [
                ...this.roundingDirectionGroup.querySelectorAll('[data-rounding-direction]'),
            ]
            const index = options.findIndex(
                (button) => button.dataset.roundingDirection === this.draft.rounding_direction
            )
            const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
            const next = options[(index + step + options.length) % options.length]
            event.preventDefault()
            next.focus()
            this.setRoundingDirection(next.dataset.roundingDirection)
        })
    }

    // -- reminders ---------------------------------------------------------

    initReminders() {
        this.markInterval(this.saved.reminder_interval_minutes)

        this.reminderToggle.addEventListener('click', () => this.toggleReminder())

        this.intervalGroup.addEventListener('click', (event) => {
            const button = event.target.closest('[data-interval]')
            if (button) this.chooseInterval(button.dataset.interval)
        })

        this.bindNumberField(this.intervalInput, 'reminder_interval_minutes', (value) =>
            this.markInterval(value)
        )
        this.bindNumberField(this.snoozeInput, 'reminder_snooze_minutes')
    }

    toggleReminder() {
        const enabled = !(this.reminderToggle.getAttribute('aria-checked') === 'true')
        this.markReminderEnabled(enabled)
        this.stage('reminder_enabled', enabled)
    }

    markReminderEnabled(enabled) {
        this.reminderToggle.setAttribute('aria-checked', enabled ? 'true' : 'false')
        this.reminderOptions.dataset.active = enabled ? 'true' : 'false'
    }

    /**
     * A preset button, or "Custom" — which only reveals the field. Committing a
     * custom value is the field's own job, so clicking Custom never writes a
     * half-typed number.
     */
    chooseInterval(choice) {
        if (choice === 'custom') {
            this.markInterval(null)
            this.intervalInput.focus()
            this.intervalInput.select()
            return
        }

        const minutes = Number(choice)
        this.intervalInput.value = String(minutes)
        this.markInterval(minutes)
        this.commit('reminder_interval_minutes', minutes, this.intervalInput)
    }

    /**
     * Highlight the preset matching `minutes`, or fall back to Custom.
     *
     * `null` forces Custom even when the current value happens to be a preset —
     * that's the "I clicked Custom to type something else" case.
     */
    markInterval(minutes) {
        const isPreset = minutes !== null && INTERVAL_PRESETS.includes(minutes)
        const active = isPreset ? String(minutes) : 'custom'

        this.intervalGroup.querySelectorAll('[data-interval]').forEach((button) => {
            const selected = button.dataset.interval === active
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
            button.tabIndex = selected ? 0 : -1
        })

        this.intervalCustom.classList.toggle('hidden', isPreset)
        this.intervalCustom.classList.toggle('flex', !isPreset)
    }

    /** Wire a valid number input into the current draft. */
    bindNumberField(input, key, onCommit) {
        const commit = () => {
            const value = this.readNumber(input)
            if (value === null) return
            if (onCommit) onCommit(value)
            this.commit(key, value, input)
        }

        input.addEventListener('input', () => {
            commit()
        })

        // `change` covers blur and the spinner arrows; Enter is explicit because
        // there's no form to submit.
        input.addEventListener('change', commit)
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') input.blur()
        })

        // A field left empty or out of range would otherwise sit there looking
        // like a saved value. Snap it back to what's actually stored.
        input.addEventListener('blur', () => {
            if (this.readNumber(input) === null) input.value = String(this.draft[key])
        })
    }

    /** The field's value as an in-range integer, or null if it isn't one. */
    readNumber(input) {
        const value = Number(input.value)
        if (!Number.isInteger(value)) return null
        if (value < Number(input.min) || value > Number(input.max)) return null
        return value
    }

    /** Stage one validated numeric value. */
    commit(key, value) {
        if (this.draft[key] === value) return
        this.stage(key, value)
    }

    // -- dev tools ---------------------------------------------------------

    initDevTools() {
        if (!this.testButton) return

        this.testButton.addEventListener('click', () => this.sendTestNotification())
        this.refreshStatus()
    }

    async sendTestNotification() {
        this.testButton.disabled = true
        try {
            const result = await this.fetchFromAPI('/api/reminder/test', { method: 'POST' })
            if (result.sent) {
                this.showToast('Notification sent — check the bottom right of your screen.')
            } else {
                // The interesting failure: the toast layer is unavailable. Say
                // why rather than leaving the tester wondering if Windows ate it.
                this.showToast(`Not sent: ${result.error || 'unknown reason'}`, 'error')
            }
            this.renderStatus(result.status)
        } catch (error) {
            this.showToast('Could not reach the reminder service.', 'error')
        } finally {
            this.testButton.disabled = false
        }
    }

    async refreshStatus() {
        try {
            this.renderStatus(await this.fetchFromAPI('/api/reminder/status'))
        } catch (error) {
            this.statusList.innerHTML = '<div class="tk-empty py-2">Status unavailable.</div>'
        }
    }

    renderStatus(status) {
        if (!this.statusList || !status) return

        const countdown =
            status.seconds_until_due === null
                ? 'not counting'
                : `${Math.floor(status.seconds_until_due / 60)}m ${status.seconds_until_due % 60}s`

        const rows = [
            ['Timer thread', status.running ? 'running' : 'stopped'],
            [
                'Windows toasts',
                status.notifications_available
                    ? 'available'
                    : `unavailable — ${status.unavailable_reason}`,
            ],
            [
                'Active task now',
                status.eligible_now
                    ? `yes — task #${status.active_task_id}`
                    : 'no — staying quiet',
            ],
            [
                'Next reminder in',
                status.held_task_id !== null && status.held_task_id !== undefined
                    ? `held until a task after #${status.held_task_id}`
                    : status.snoozed
                      ? `${countdown} (snoozed)`
                      : countdown,
            ],
            ['Sent this session', String(status.sent_count)],
        ]

        if (status.last_error) rows.push(['Last error', status.last_error])

        this.statusList.innerHTML = rows
            .map(
                () =>
                    '<div class="flex justify-between gap-4 py-1">' +
                    '<dt class="text-faint"></dt><dd class="tabular text-right"></dd></div>'
            )
            .join('')

        // Filled as text, not interpolated: `unavailable_reason` and
        // `last_error` are exception strings and could contain anything.
        this.statusList.querySelectorAll('div').forEach((row, index) => {
            row.querySelector('dt').textContent = rows[index][0]
            row.querySelector('dd').textContent = rows[index][1]
        })
    }

    // -- draft and persistence --------------------------------------------

    stage(key, value) {
        this.draft[key] = value
        this.saveBar.setDirty(JSON.stringify(this.draft) !== JSON.stringify(this.saved))
    }

    applyState(state) {
        applyTheme(state.theme)
        this.markThemeSelected(state.theme)
        applyTimeFormat(state.time_format)
        this.markTimeFormatSelected(state.time_format)
        this.markRoundingEnabled(state.rounding_enabled)
        this.roundingIntervalInput.value = String(state.rounding_interval_minutes)
        this.markRoundingInterval(state.rounding_interval_minutes)
        this.markRoundingDirection(state.rounding_direction)
        this.markReminderEnabled(state.reminder_enabled)
        this.intervalInput.value = String(state.reminder_interval_minutes)
        this.markInterval(state.reminder_interval_minutes)
        this.snoozeInput.value = String(state.reminder_snooze_minutes)
    }

    cancelChanges() {
        this.draft = { ...this.saved }
        this.applyState(this.draft)
        return true
    }

    async saveChanges() {
        try {
            const response = await this.fetchFromAPI('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.draft),
            })
            const confirmed = Object.fromEntries(
                Object.keys(this.saved).map((key) => [key, response[key]])
            )
            this.saved = confirmed
            this.draft = { ...confirmed }
            this.applyState(confirmed)
            this.showToast('Settings saved.')
            return true
        } catch (error) {
            return false
        }
    }
}

ready(() => new Settings().init())
