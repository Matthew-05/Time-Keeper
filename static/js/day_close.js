/**
 * The startup close-out prompt.
 *
 * A task only stays open past midnight because someone closed the laptop
 * without pressing *Complete task*. The time it actually ended is the one fact
 * about it the database cannot derive (see `day_close.py` for what it can), so
 * the app asks — once, at launch, before anything else can be done.
 *
 * **The dialog is deliberately inescapable.** No close button, no Escape, no
 * click-outside, and the backdrop covers the navigation. That is a real cost
 * imposed on the user and it is worth it exactly once: an open task contributes
 * nothing to History, Summary or any budget, so a dismissible prompt is a
 * prompt that gets dismissed until nobody remembers what Thursday afternoon
 * was, and the time is gone. The ask is one number, and it is asked on the
 * morning after rather than a month later.
 *
 * Loaded from `base.html` on every page rather than from the Today page alone:
 * the window opens on Today, but a task that is blocking every figure in the
 * app shouldn't become answerable only by navigating back to one screen.
 *
 * The server drives the sequence. Each answer POSTs back and the response says
 * what is still outstanding, so the modal never holds a list that the sweep has
 * since changed underneath it, and the day capping is guaranteed to run in the
 * same request that closes the final task.
 */

import { TimeKeeper, lockBodyScroll, unlockBodyScroll, ready } from './base.js'
import { localDate } from './calendar_dates.js'
import { flatpickrTimeOptions, formatClockTime, serializeClockTime } from './time_format.js'

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
})

class DayCloseDialog {
    constructor() {
        // TimeKeeper is the app's fetch/toast layer; this needs both and none of
        // the page behaviour any of its subclasses add.
        this.api = new TimeKeeper()
        this.tasks = []
        this.picker = null
        this.busy = false
        this.element = null
    }

    /**
     * Run the sweep and, if the server has questions, ask them.
     *
     * The request is retried like a read despite being a POST: it is idempotent
     * by construction, and this fires while the Flask server may still be
     * coming up behind the webview.
     */
    async run() {
        let response
        try {
            response = await this.api.fetchFromAPI(
                '/api/day-close/sweep',
                { method: 'POST' },
                { retries: 40, quiet: true },
            )
        } catch (error) {
            // Nothing is shown and nothing is lost — the sweep runs again on the
            // next launch. A toast here would fire on every page of a session
            // where the server is unwell, which is noise on top of an outage
            // the user is already seeing.
            console.error('Day close sweep failed:', error)
            return
        }

        this.tasks = response.tasks ?? []
        if (!this.tasks.length) {
            this.announce(response.capped)
            return
        }

        this.mount()
        this.render()
    }

    /** Say what the sweep did on its own, but only when it did something. */
    announce(capped) {
        if (!capped) return
        const parts = []
        if (capped.closed) parts.push(`${capped.closed} day${capped.closed === 1 ? '' : 's'} closed`)
        if (capped.deleted) {
            parts.push(`${capped.deleted} empty day${capped.deleted === 1 ? '' : 's'} removed`)
        }
        if (parts.length) this.api.showToast(parts.join(', '), 'info')
    }

    mount() {
        if (this.element) return

        this.element = document.createElement('div')
        this.element.className = 'tk-modal-backdrop tk-day-close-backdrop'
        this.element.setAttribute('role', 'dialog')
        this.element.setAttribute('aria-modal', 'true')
        this.element.setAttribute('aria-labelledby', 'day-close-title')
        this.element.innerHTML = `
            <div class="tk-modal">
                <div class="tk-modal-header">
                    <div>
                        <h2 class="text-base font-semibold text-text" id="day-close-title">Unfinished task</h2>
                        <p class="mt-1 text-xs text-muted" data-day-close-progress></p>
                    </div>
                </div>
                <div class="tk-modal-body space-y-4">
                    <p class="text-sm text-muted">
                        This task was never completed, so none of its time is counted anywhere.
                        When did it end?
                    </p>
                    <dl class="space-y-1 text-sm">
                        <div class="flex items-center justify-between gap-3">
                            <dt class="text-muted">Client</dt>
                            <dd class="font-semibold text-text" data-day-close-client></dd>
                        </div>
                        <div class="flex items-center justify-between gap-3">
                            <dt class="text-muted">Date</dt>
                            <dd class="font-semibold text-text" data-day-close-date></dd>
                        </div>
                        <div class="flex items-center justify-between gap-3">
                            <dt class="text-muted">Started</dt>
                            <dd class="tabular font-semibold text-text" data-day-close-start></dd>
                        </div>
                    </dl>
                    <div>
                        <label class="mb-1 block text-xs font-medium text-muted" for="day-close-time">End time</label>
                        <input
                            type="text"
                            id="day-close-time"
                            class="tk-input tk-time w-full py-2 text-center text-2xl font-semibold tracking-[-0.01em]"
                            placeholder="Select a time"
                        />
                        <p class="tk-time-guidance tabular text-xs text-faint" data-day-close-hint></p>
                    </div>
                </div>
                <div class="tk-modal-footer flex justify-end">
                    <button type="button" class="tk-btn tk-btn-primary tk-btn-lg" data-day-close-save disabled>
                        Close task
                    </button>
                </div>
            </div>
        `
        document.body.appendChild(this.element)
        lockBodyScroll()

        this.progress = this.element.querySelector('[data-day-close-progress]')
        this.clientCell = this.element.querySelector('[data-day-close-client]')
        this.dateCell = this.element.querySelector('[data-day-close-date]')
        this.startCell = this.element.querySelector('[data-day-close-start]')
        this.hint = this.element.querySelector('[data-day-close-hint]')
        this.input = this.element.querySelector('#day-close-time')
        this.saveButton = this.element.querySelector('[data-day-close-save]')

        this.saveButton.addEventListener('click', () => this.save())

        // No Escape handler and no backdrop-click handler, deliberately: this
        // modal is closed by answering it and by nothing else. Nothing in the
        // app dismisses an arbitrary modal on Escape, so there is nothing to
        // suppress — and swallowing the key here would stop flatpickr closing
        // its own clock, which is the one thing on screen that should.
    }

    /** Point the dialog at the first outstanding task. */
    render() {
        const task = this.tasks[0]
        const total = this.tasks.length

        this.progress.textContent = total === 1
            ? 'One task was left running.'
            : `1 of ${total} tasks were left running.`
        this.clientCell.textContent = task.client
        this.dateCell.textContent = DATE_FORMAT.format(localDate(task.date))
        this.startCell.textContent = formatClockTime(task.start_time)
        this.hint.textContent = `Must be ${formatClockTime(task.start_time)} or later.`

        // Rebuilt per task rather than reconfigured: minTime is the only thing
        // standing between a typed value and a negative duration, and a stale
        // one from the previous task would be the wrong floor.
        this.picker?.destroy()
        this.input.value = ''
        this.picker = flatpickr(this.input, flatpickrTimeOptions({
            minTime: task.start_time,
            onChange: () => this.syncSaveButton(),
        }))
        this.syncSaveButton()
        this.input.focus()
    }

    syncSaveButton() {
        this.saveButton.disabled = this.busy || !this.input.value
    }

    async save() {
        if (this.busy || !this.input.value) return

        this.busy = true
        this.saveButton.disabled = true
        this.saveButton.textContent = 'Closing...'

        try {
            const response = await this.api.fetchFromAPI('/api/day-close/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task_id: this.tasks[0].id,
                    end_time: serializeClockTime(this.input.value),
                }),
            })

            this.tasks = response.tasks ?? []
            if (this.tasks.length) {
                this.render()
                return
            }

            this.dismiss()
            this.api.showToast('Everything is closed out', 'success')
            this.announce(response.capped)
        } catch (error) {
            // fetchFromAPI has already raised the server's own message as a
            // toast. Swallow it here so the dialog simply stays put with the
            // time still in the field, ready to be corrected — rethrowing
            // would only reach the unhandledrejection logger.
            console.error('Could not close the task:', error)
        } finally {
            this.busy = false
            if (this.element) {
                this.saveButton.textContent = 'Close task'
                this.syncSaveButton()
            }
        }
    }

    dismiss() {
        this.picker?.destroy()
        this.picker = null
        this.element?.remove()
        this.element = null
        unlockBodyScroll()
    }
}

/**
 * Only ever one sweep per document, even though several modules import this.
 * Two dialogs stacked on the same task would race each other's POSTs, and the
 * loser would be told the task is already closed.
 */
let started = null

export function runDayClose() {
    if (!started) started = new DayCloseDialog().run()
    return started
}

ready(runDayClose)
