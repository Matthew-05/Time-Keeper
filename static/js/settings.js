import { TimeKeeper, ready } from './base.js'
import { applyTheme, currentMode } from './theme.js'
import { applyTimeFormat, currentTimeFormat } from './time_format.js'

/**
 * Settings page.
 *
 * Each control applies its change immediately and saves in the background —
 * there's no Save button to forget to press, and with a local backend the write
 * is effectively instant. The optimistic apply is rolled back if the write
 * fails, so what you see always matches what's on disk.
 *
 * Nothing here fetches the current settings: every control is rendered at its
 * stored value by Jinja, so the page is already correct before this module
 * evaluates. What we keep instead is `saved` — the last value the *server*
 * confirmed — which is what a failed write rolls back to.
 */

const INTERVAL_PRESETS = [15, 30, 60]

// Typing "45" into a number field fires three input events. Wait for a pause
// before writing, but save on blur/Enter regardless so a change is never lost.
const TYPING_PAUSE_MS = 600

class Settings extends TimeKeeper {
    constructor() {
        super()
        this.themeGroup = document.getElementById('theme-mode')
        this.timeFormatGroup = document.getElementById('time-format')

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
            time_format: currentTimeFormat(),
            reminder_enabled: this.reminderToggle.getAttribute('aria-checked') === 'true',
            reminder_interval_minutes: Number(this.intervalInput.value),
            reminder_snooze_minutes: Number(this.snoozeInput.value),
        }

        this.pendingSaves = new Map()
        this.timeFormatSaveQueue = Promise.resolve()
        this.timeFormatIntent = 0
    }

    init() {
        this.initTheme()
        this.initTimeFormat()
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

    async setTheme(mode) {
        const previous = currentMode()
        if (mode === previous) return

        // Apply first: the point of a theme switch is seeing it happen.
        applyTheme(mode)
        this.markThemeSelected(mode)

        try {
            const saved = await this.save({ theme: mode })
            // Trust the server's answer over ours — it validated the value.
            if (saved.theme !== mode) {
                applyTheme(saved.theme)
                this.markThemeSelected(saved.theme)
            }
        } catch (error) {
            // The write failed, so the file still says `previous`. Put the page
            // back in sync with it instead of leaving a theme that won't
            // survive a reload.
            applyTheme(previous)
            this.markThemeSelected(previous)
        }
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

    async setTimeFormat(timeFormat) {
        if (timeFormat === currentTimeFormat()) return
        const intent = ++this.timeFormatIntent

        applyTimeFormat(timeFormat)
        this.markTimeFormatSelected(timeFormat)

        // Serialize writes so the server's final value follows the user's click
        // order. The intent token prevents an older response from repainting a
        // newer optimistic choice while rapid toggles are still queued.
        const request = this.timeFormatSaveQueue.then(() => this.save({ time_format: timeFormat }))
        this.timeFormatSaveQueue = request.catch(() => {})

        try {
            const saved = await request
            this.saved.time_format = saved.time_format
            if (intent === this.timeFormatIntent) {
                applyTimeFormat(saved.time_format)
                this.markTimeFormatSelected(saved.time_format)
            }
        } catch (error) {
            if (intent === this.timeFormatIntent) {
                applyTimeFormat(this.saved.time_format)
                this.markTimeFormatSelected(this.saved.time_format)
            }
        }
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

    async toggleReminder() {
        const enabled = !(this.reminderToggle.getAttribute('aria-checked') === 'true')
        this.markReminderEnabled(enabled)

        try {
            const saved = await this.save({ reminder_enabled: enabled })
            this.saved.reminder_enabled = saved.reminder_enabled
            this.markReminderEnabled(saved.reminder_enabled)
        } catch (error) {
            this.markReminderEnabled(this.saved.reminder_enabled)
        }
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

    /** Wire a number input: debounced while typing, immediate on blur/Enter. */
    bindNumberField(input, key, onCommit) {
        const commit = () => {
            const value = this.readNumber(input)
            if (value === null) return
            if (onCommit) onCommit(value)
            this.commit(key, value, input)
        }

        input.addEventListener('input', () => {
            clearTimeout(this.pendingSaves.get(key))
            this.pendingSaves.set(key, setTimeout(commit, TYPING_PAUSE_MS))
        })

        // `change` covers blur and the spinner arrows; Enter is explicit because
        // there's no form to submit.
        input.addEventListener('change', () => {
            clearTimeout(this.pendingSaves.get(key))
            commit()
        })
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') input.blur()
        })

        // A field left empty or out of range would otherwise sit there looking
        // like a saved value. Snap it back to what's actually stored.
        input.addEventListener('blur', () => {
            if (this.readNumber(input) === null) input.value = String(this.saved[key])
        })
    }

    /** The field's value as an in-range integer, or null if it isn't one. */
    readNumber(input) {
        const value = Number.parseInt(input.value, 10)
        if (!Number.isFinite(value)) return null
        if (value < Number(input.min) || value > Number(input.max)) return null
        return value
    }

    /** Persist one key, rolling the field back to the stored value on failure. */
    async commit(key, value, input) {
        if (this.saved[key] === value) return

        try {
            const saved = await this.save({ [key]: value })
            this.saved[key] = saved[key]
            // The server clamps and validates; show what it actually stored.
            if (saved[key] !== value) {
                input.value = String(saved[key])
                if (input === this.intervalInput) this.markInterval(saved[key])
            }
        } catch (error) {
            input.value = String(this.saved[key])
            if (input === this.intervalInput) this.markInterval(this.saved[key])
        }
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

    // -- persistence -------------------------------------------------------

    /** PUT a partial settings object. Not retried — see fetchFromAPI. */
    save(changes) {
        return this.fetchFromAPI('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(changes),
        })
    }
}

ready(() => new Settings().init())
