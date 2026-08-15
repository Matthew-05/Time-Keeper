import { makeModalBackdropStatic, lockBodyScroll, unlockBodyScroll } from './base.js'

/**
 * Page-level save/cancel control for editors that keep changes in memory until
 * the user explicitly confirms them.
 */
export class SaveChangesBar {
    constructor({ onSave, onCancel }) {
        this.onSave = onSave
        this.onCancel = onCancel
        this.dirty = false
        this.busy = false
        this.pendingNavigation = null
        this.pendingAction = null
        this.returnFocus = null
        this.historyGuardId = `unsaved-${Date.now()}-${Math.random().toString(16).slice(2)}`
        this.historyGuardActive = false
        this.historyPopSuppressed = false
        this.historyDisarmResolve = null
        this.exitAfterSave = false

        this.element = document.createElement('section')
        this.element.className = 'tk-save-changes'
        this.element.hidden = true
        this.element.setAttribute('aria-label', 'Unsaved changes')
        this.element.innerHTML = `
            <div class="tk-save-changes-content">
                <span class="tk-save-changes-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                        <path d="M17 21v-8H7v8M7 3v5h8" />
                    </svg>
                </span>
                <div class="tk-save-changes-copy">
                    <strong>Unsaved changes</strong>
                </div>
            </div>
            <div class="tk-save-changes-actions">
                <button type="button" class="tk-btn tk-btn-ghost" data-save-cancel>Cancel</button>
                <button type="button" class="tk-btn tk-btn-primary" data-save-confirm>Save changes</button>
            </div>
        `
        document.body.appendChild(this.element)

        this.navigationModal = document.createElement('div')
        this.navigationModal.className = 'tk-modal-backdrop tk-unsaved-backdrop hidden'
        this.navigationModal.setAttribute('role', 'dialog')
        this.navigationModal.setAttribute('aria-modal', 'true')
        this.navigationModal.setAttribute('aria-labelledby', 'unsaved-navigation-title')
        this.navigationModal.innerHTML = `
            <div class="tk-modal tk-unsaved-modal">
                <div class="tk-modal-header">
                    <div>
                        <h2 class="text-base font-semibold text-text" id="unsaved-navigation-title">Save your changes?</h2>
                        <p class="mt-1 text-xs text-muted">Your edits have not been applied yet.</p>
                    </div>
                </div>
                <div class="tk-modal-body">
                    <p class="text-sm text-muted">Save now to keep your changes before continuing.</p>
                </div>
                <div class="tk-modal-footer tk-unsaved-modal-actions">
                    <button type="button" class="tk-btn tk-btn-secondary" data-navigation-stay>Cancel</button>
                    <button type="button" class="tk-btn tk-btn-primary" data-navigation-save>Save and leave</button>
                </div>
            </div>
        `
        document.body.appendChild(this.navigationModal)

        this.cancelButton = this.element.querySelector('[data-save-cancel]')
        this.saveButton = this.element.querySelector('[data-save-confirm]')
        this.stayButton = this.navigationModal.querySelector('[data-navigation-stay]')
        this.saveAndLeaveButton = this.navigationModal.querySelector('[data-navigation-save]')
        this.cancelButton.addEventListener('click', () => this.cancel())
        this.saveButton.addEventListener('click', () => this.save())
        this.stayButton.addEventListener('click', () => this.hideNavigationModal())
        this.saveAndLeaveButton.addEventListener('click', () => this.saveAndExit())
        makeModalBackdropStatic(this.navigationModal)
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.navigationModal.classList.contains('hidden')) {
                this.hideNavigationModal()
            }
        })
        document.addEventListener('click', (event) => this.interceptExit(event), true)
        window.addEventListener('popstate', (event) => this.interceptHistoryTraversal(event))
    }

    setDirty(dirty) {
        const wasDirty = this.dirty
        this.dirty = Boolean(dirty)
        this.element.hidden = !this.dirty
        document.body.classList.toggle('tk-save-changes-visible', this.dirty)

        if (this.dirty && !wasDirty) this.armHistoryGuard()
        if (!this.dirty && wasDirty && !this.exitAfterSave) {
            this.disarmHistoryGuard()
        }
    }

    async save() {
        if (!this.dirty || this.busy) return false
        this.setBusy(true, 'Saving...')
        try {
            const saved = await this.onSave()
            if (saved !== false) this.setDirty(false)
            return saved !== false
        } finally {
            this.setBusy(false, 'Save changes')
        }
    }

    async cancel() {
        if (!this.dirty || this.busy) return
        this.setBusy(true)
        try {
            const cancelled = await this.onCancel()
            if (cancelled !== false) this.setDirty(false)
        } finally {
            this.setBusy(false)
        }
    }

    setBusy(busy, saveLabel = 'Save changes') {
        this.busy = busy
        this.saveButton.disabled = busy
        this.cancelButton.disabled = busy
        this.saveButton.textContent = saveLabel
    }

    interceptExit(event) {
        if (!this.dirty || event.defaultPrevented || event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

        const closeButton = event.target.closest?.('[data-window-action="close"]')
        if (closeButton) {
            event.preventDefault()
            event.stopPropagation()
            this.showInterruption({
                action: () => window.pywebview?.api.close(),
                verb: 'close',
            })
            return
        }

        const anchor = event.target.closest?.('a[href]')
        if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return

        const destination = new URL(anchor.href, window.location.href)
        const current = new URL(window.location.href)
        const sameDocument = destination.origin === current.origin
            && destination.pathname === current.pathname
            && destination.search === current.search
        if (sameDocument && destination.hash !== current.hash) return

        event.preventDefault()
        event.stopPropagation()
        this.showInterruption({ destination: destination.href, verb: 'leave' })
    }

    armHistoryGuard() {
        if (this.historyGuardActive) return
        window.history.pushState(
            { timeKeeperUnsavedGuard: this.historyGuardId },
            '',
            window.location.href,
        )
        this.historyGuardActive = true
    }

    async disarmHistoryGuard() {
        if (!this.historyGuardActive) return
        this.historyGuardActive = false
        this.historyPopSuppressed = true

        await new Promise((resolve) => {
            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                this.historyPopSuppressed = false
                this.historyDisarmResolve = null
                resolve()
            }
            this.historyDisarmResolve = finish
            window.history.back()
            setTimeout(finish, 250)
        })
    }

    interceptHistoryTraversal() {
        if (this.historyPopSuppressed) {
            this.historyPopSuppressed = false
            this.historyDisarmResolve?.()
            return
        }
        if (!this.dirty || !this.historyGuardActive) return

        // Back/Forward has moved from our duplicate guard entry to the real
        // page entry. Re-arm immediately so another side-button press cannot
        // escape while the interruption is open.
        this.historyGuardActive = false
        this.armHistoryGuard()
        if (!this.navigationModal.classList.contains('hidden')) return

        this.showInterruption({
            action: () => window.history.back(),
            verb: 'leave',
        })
    }

    showInterruption({ destination = null, action = null, verb }) {
        this.pendingNavigation = destination
        this.pendingAction = action
        this.returnFocus = document.activeElement
        this.saveAndLeaveButton.textContent = `Save and ${verb}`
        this.saveAndLeaveButton.dataset.exitVerb = verb
        this.navigationModal.classList.remove('hidden')
        lockBodyScroll()
        this.stayButton.focus()
    }

    hideNavigationModal() {
        if (this.navigationModal.classList.contains('hidden')) return
        this.navigationModal.classList.add('hidden')
        this.pendingNavigation = null
        this.pendingAction = null
        unlockBodyScroll()
        this.returnFocus?.focus?.()
        this.returnFocus = null
    }

    setModalBusy(busy) {
        this.stayButton.disabled = busy
        this.saveAndLeaveButton.disabled = busy
        const verb = this.saveAndLeaveButton.dataset.exitVerb || 'leave'
        this.saveAndLeaveButton.textContent = busy ? 'Saving...' : `Save and ${verb}`
    }

    async performPendingExit() {
        const destination = this.pendingNavigation
        const action = this.pendingAction
        if (!destination && !action) return
        this.setDirty(false)
        this.navigationModal.classList.add('hidden')
        unlockBodyScroll()
        await this.disarmHistoryGuard()
        this.exitAfterSave = false
        if (destination) {
            window.location.assign(destination)
            return
        }

        try {
            await action()
        } catch (error) {
            console.error('Could not complete the requested window action:', error)
            this.setDirty(true)
        }
    }

    async saveAndExit() {
        if (this.busy) return
        this.setModalBusy(true)
        this.exitAfterSave = true
        const saved = await this.save()
        if (!saved) this.exitAfterSave = false
        this.setModalBusy(false)
        if (saved) await this.performPendingExit()
    }
}
