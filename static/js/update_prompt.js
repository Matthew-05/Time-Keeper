/**
 * Startup update prompt.
 *
 * The packaged app starts its network check before creating the webview. This
 * module watches that background state on every page and stays invisible unless
 * a newer release is actually available. Downloading and verification remain
 * in Python; the browser owns only the user-facing state machine.
 */

import {
    TimeKeeper,
    makeModalBackdropStatic,
    lockBodyScroll,
    ready,
    unlockBodyScroll,
} from './base.js'

const POLL_DELAY = 500
const DISMISS_KEY_PREFIX = 'timekeeper-update-later:'

export class StartupUpdatePrompt {
    constructor(api = new TimeKeeper()) {
        this.api = api
        this.element = null
        this.status = null
        this.pollTimer = null
        this.requestPending = false
    }

    async start() {
        await this.refresh()
    }

    async refresh() {
        clearTimeout(this.pollTimer)
        try {
            const status = await this.api.fetchFromAPI(
                '/api/update/status',
                {},
                { timeout: 5000, retries: 40, quiet: true },
            )
            this.handleStatus(status)
        } catch (error) {
            // A startup update failure must never block the application. The
            // Settings page remains the place to inspect/retry silent failures.
            console.error('Startup update status failed:', error)
            this.dismiss(false)
        }
    }

    handleStatus(status) {
        if (!status?.frozen) {
            this.dismiss(false)
            return
        }

        this.status = status
        if (status.state === 'idle' || status.state === 'checking') {
            this.schedulePoll()
            return
        }
        if (status.state === 'up_to_date') {
            this.dismiss(false)
            return
        }

        // Check errors stay quiet unless the user already opened this prompt
        // by choosing an update action. A failed background request should not
        // greet every launch with an error dialog.
        if (status.state === 'error' && !this.element) return

        if (status.state === 'available' && this.wasDismissed(status.latest_version)) {
            return
        }

        if (document.querySelector('.tk-day-close-backdrop')) {
            // The close-out dialog is intentionally inescapable and must win
            // startup. Recheck after it is answered instead of stacking modals.
            this.schedulePoll()
            return
        }

        this.mount()
        this.render(status)

        if (['downloading', 'installing'].includes(status.state)) {
            this.schedulePoll()
        }
    }

    mount() {
        if (this.element) return

        this.element = document.createElement('div')
        this.element.className = 'tk-modal-backdrop tk-update-backdrop'
        this.element.setAttribute('role', 'dialog')
        this.element.setAttribute('aria-modal', 'true')
        this.element.setAttribute('aria-labelledby', 'startup-update-title')
        this.element.innerHTML = `
            <div class="tk-modal tk-update-modal">
                <div class="tk-modal-header">
                    <div>
                        <h2 class="text-base font-semibold text-text" id="startup-update-title">
                            Update available
                        </h2>
                        <p class="mt-1 text-xs text-muted" data-update-versions></p>
                    </div>
                    <button type="button" class="tk-btn-icon tk-btn-icon-sm" data-update-close title="Later" aria-label="Close update prompt">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                            <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                    </button>
                </div>
                <div class="tk-modal-body space-y-4">
                    <p class="text-sm text-muted" data-update-message></p>
                    <div class="tk-update-progress hidden" data-update-progress-wrap aria-hidden="true">
                        <div class="tk-update-progress-track">
                            <div
                                class="tk-update-progress-bar"
                                data-update-progress
                                role="progressbar"
                                aria-label="Update download progress"
                                aria-valuemin="0"
                                aria-valuemax="100"
                                aria-valuenow="0"
                            ></div>
                        </div>
                        <p class="mt-1 text-xs tabular text-faint" data-update-progress-label>0%</p>
                    </div>
                    <a
                        class="inline-flex text-sm text-accent hover:underline"
                        data-update-release
                        href="#"
                        target="_blank"
                        rel="noopener noreferrer"
                    >View release notes</a>
                </div>
                <div class="tk-modal-footer flex items-center justify-end gap-2">
                    <button type="button" class="tk-btn tk-btn-secondary" data-update-later>Later</button>
                    <button type="button" class="tk-btn tk-btn-primary" data-update-action>Download update</button>
                </div>
            </div>
        `
        document.body.appendChild(this.element)
        lockBodyScroll()

        this.title = this.element.querySelector('#startup-update-title')
        this.versions = this.element.querySelector('[data-update-versions]')
        this.message = this.element.querySelector('[data-update-message]')
        this.progressWrap = this.element.querySelector('[data-update-progress-wrap]')
        this.progress = this.element.querySelector('[data-update-progress]')
        this.progressLabel = this.element.querySelector('[data-update-progress-label]')
        this.releaseLink = this.element.querySelector('[data-update-release]')
        this.closeButton = this.element.querySelector('[data-update-close]')
        this.laterButton = this.element.querySelector('[data-update-later]')
        this.actionButton = this.element.querySelector('[data-update-action]')

        this.closeButton.addEventListener('click', () => this.dismiss(true))
        this.laterButton.addEventListener('click', () => this.dismiss(true))
        this.actionButton.addEventListener('click', () => this.performAction())
        makeModalBackdropStatic(this.element)
        document.addEventListener('keydown', this.handleKeydown)
        this.actionButton.focus()
    }

    handleKeydown = (event) => {
        if (event.key === 'Escape' && this.status?.state !== 'installing') {
            this.dismiss(true)
        }
    }

    render(status) {
        if (!this.element) return
        const current = status.current_version ? `v${status.current_version}` : 'this version'
        const latest = status.latest_version ? `v${status.latest_version}` : 'the new version'
        const views = {
            available: {
                title: 'Update available',
                message: `${latest} is ready to download. The installer keeps your existing Time Keeper data and settings.`,
                action: 'Download update',
                disabled: false,
            },
            downloading: {
                title: 'Downloading update',
                message: `Downloading and verifying ${latest}. You can keep using Time Keeper.`,
                action: 'Downloading…',
                disabled: true,
            },
            ready: {
                title: 'Ready to install',
                message: `${latest} has been downloaded and verified. Time Keeper will close when the installer opens.`,
                action: 'Install and restart',
                disabled: false,
            },
            installing: {
                title: 'Opening installer',
                message: 'Time Keeper is closing so the installer can safely replace the application files.',
                action: 'Opening installer…',
                disabled: true,
            },
            error: {
                title: 'Update interrupted',
                message: status.error || 'The update could not be completed. Your current installation was not changed.',
                action: 'Check again',
                disabled: false,
            },
        }
        const view = views[status.state] || views.available

        this.title.textContent = view.title
        this.versions.textContent = `${current} → ${latest}`
        this.message.textContent = view.message
        this.actionButton.textContent = view.action
        this.actionButton.disabled = view.disabled || this.requestPending

        const installing = status.state === 'installing'
        this.closeButton.disabled = installing
        this.laterButton.disabled = installing

        const showProgress = status.state === 'downloading'
        const percentage = Number.isFinite(status.progress)
            ? Math.max(0, Math.min(status.progress, 100))
            : 0
        this.progressWrap.classList.toggle('hidden', !showProgress)
        this.progressWrap.setAttribute('aria-hidden', showProgress ? 'false' : 'true')
        this.progress.style.width = `${percentage}%`
        this.progress.setAttribute('aria-valuenow', String(percentage))
        this.progressLabel.textContent = `${percentage}%`

        const showRelease = Boolean(status.release_url)
        this.releaseLink.classList.toggle('hidden', !showRelease)
        if (showRelease) this.releaseLink.href = status.release_url
    }

    async performAction() {
        if (this.requestPending || !this.status) return
        const endpoint =
            this.status.state === 'available'
                ? '/api/update/download'
                : this.status.state === 'ready'
                  ? '/api/update/install'
                  : '/api/update/check'

        this.requestPending = true
        this.render(this.status)
        try {
            const status = await this.api.fetchFromAPI(
                endpoint,
                { method: 'POST' },
                { timeout: 10000, retries: 0, quiet: true },
            )
            this.requestPending = false
            this.handleStatus(status)
        } catch (error) {
            this.requestPending = false
            this.status = { ...this.status, state: 'error', error: error.message }
            this.render(this.status)
        }
    }

    schedulePoll() {
        clearTimeout(this.pollTimer)
        this.pollTimer = setTimeout(() => this.refresh(), POLL_DELAY)
    }

    wasDismissed(version) {
        if (!version) return false
        try {
            return sessionStorage.getItem(`${DISMISS_KEY_PREFIX}${version}`) === '1'
        } catch {
            return false
        }
    }

    dismiss(remember) {
        clearTimeout(this.pollTimer)
        if (remember && this.status?.latest_version) {
            try {
                sessionStorage.setItem(
                    `${DISMISS_KEY_PREFIX}${this.status.latest_version}`,
                    '1',
                )
            } catch {
                // Storage can be disabled; dismissal still applies to this page.
            }
        }
        if (!this.element) return
        document.removeEventListener('keydown', this.handleKeydown)
        this.element.remove()
        this.element = null
        unlockBodyScroll()
    }
}

let started = null

export function runStartupUpdatePrompt() {
    if (!started) started = new StartupUpdatePrompt().start()
    return started
}

ready(runStartupUpdatePrompt)
