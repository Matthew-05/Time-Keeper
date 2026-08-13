/**
 * Works — what you did for a client on a day.
 *
 * Replaces the old per-task description. A work belongs to a (client, date),
 * not to a time block, so the same list is shown whichever of that client's
 * tasks happens to be running, and it's the list that gets copied out at the
 * end of the day.
 *
 * One renderer serves both consumers: the inline container on the Today page
 * and the modal on the Task Browser. They differ only in where the element
 * lives and whether the target changes while it's on screen.
 */

import { confirmAction } from './base.js';

/** Join for the clipboard: creation order, comma-separated. */
export function joinWorks(works) {
    return works.map((w) => w.text).join(', ');
}

/** Fetch one client's works for one day. Returns [] when either is missing. */
export async function fetchWorks(api, dateStr, clientId) {
    if (!dateStr || clientId == null) return [];
    const params = new URLSearchParams({ date: dateStr, client_id: String(clientId) });
    return api.fetchFromAPI(`/api/works?${params}`);
}

export class WorksList {
    /**
     * @param {object}      options
     * @param {HTMLElement} options.container  element to render into
     * @param {object}      options.api        a TimeKeeper instance (fetchFromAPI, showToast, escapeHtml)
     * @param {string}      [options.date]     YYYY-MM-DD
     * @param {number}      [options.clientId]
     * @param {boolean}     [options.autoFocus] focus the add field after each add
     */
    constructor({ container, api, date = null, clientId = null, autoFocus = false }) {
        this.container = container;
        this.api = api;
        this.date = date;
        this.clientId = clientId;
        this.autoFocus = autoFocus;

        this.works = [];
        this.editingId = null;
        this.loading = false;
        this.failed = false;
        // Guards against an older in-flight load painting over a newer target
        // when the client is switched twice in quick succession.
        this.loadToken = 0;

        this.container.addEventListener('click', (e) => this.handleClick(e));
        this.container.addEventListener('keydown', (e) => this.handleKeydown(e));
        this.container.addEventListener('input', (e) => {
            if (e.target.classList.contains('works-add-input')) this.updateAddButton();
        });
        this.container.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleAdd();
        });
    }

    /**
     * Point the list at a different client/day and reload.
     * A no-op when nothing actually changed, so it's safe to call on every
     * render pass without causing a flicker.
     */
    async setTarget(dateStr, clientId, { force = false } = {}) {
        // The no-op only applies to a *settled* list. One showing a spinner or
        // an error has nothing on screen worth preserving, and skipping the
        // load would strand it there — which is exactly what left the Today
        // page on "Loading works…" when a task was started for the client the
        // list happened to be pointing at already.
        const settled = !this.loading && !this.failed;
        if (!force && settled && dateStr === this.date && clientId === this.clientId) return;

        this.date = dateStr;
        this.clientId = clientId;
        this.editingId = null;
        await this.load();
    }

    /**
     * Show a loading state for a target that isn't known yet.
     *
     * The dashboard reveals the works list from one request (is a task
     * running?) and learns the client from the next, so there's a moment with
     * nothing to load. A spinner beats flashing "Nothing recorded yet" at
     * someone whose list isn't empty.
     *
     * Clearing `clientId` matters as much as the spinner: it means the
     * `setTarget` that follows always has a different target to compare
     * against, whichever client turns out to be running.
     */
    showPending() {
        this.clientId = null;
        this.editingId = null;
        this.loading = true;
        this.failed = false;
        // Invalidate anything in flight — its response belongs to the previous
        // target and must not paint over the placeholder.
        this.loadToken++;
        this.render();
    }

    async load() {
        if (this.date == null || this.clientId == null) {
            this.works = [];
            this.render();
            return;
        }

        const token = ++this.loadToken;
        this.loading = this.works.length === 0;
        this.failed = false;
        this.render();

        try {
            const works = await fetchWorks(this.api, this.date, this.clientId);
            if (token !== this.loadToken) return;
            this.works = works;
            this.loading = false;
        } catch (error) {
            if (token !== this.loadToken) return;
            console.error('Failed to load works:', error);
            // Never leave the loading placeholder up — fetchFromAPI has already
            // exhausted its retries by this point, so offer a manual one.
            this.loading = false;
            this.failed = true;
        }
        this.render();
    }

    // ---- rendering ---------------------------------------------------------

    render() {
        const esc = (v) => this.api.escapeHtml(v);

        if (this.loading) {
            this.container.innerHTML =
                '<div class="tk-loading"><span class="tk-spinner"></span> Loading works…</div>';
            return;
        }

        if (this.failed) {
            this.container.innerHTML = `
                <div class="tk-empty">
                    Could not load works.
                    <button type="button" class="works-retry tk-btn tk-btn-secondary tk-btn-sm ml-2">Retry</button>
                </div>`;
            return;
        }

        const rows = this.works.length
            ? this.works.map((work) => this.renderRow(work, esc)).join('')
            : '<p class="tk-empty">Nothing recorded yet.</p>';

        this.container.innerHTML = `
            <div class="works-rows space-y-0.5">${rows}</div>
            <form class="works-add mt-2 flex items-end gap-2">
                <textarea
                    class="works-add-input tk-input"
                    placeholder="Add a work…"
                    autocomplete="off"
                    rows="3"
                    ${this.clientId == null ? 'disabled' : ''}
                ></textarea>
                <button type="submit" class="works-add-button tk-btn tk-btn-primary flex-shrink-0" disabled>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 5v14M5 12h14" />
                    </svg>
                    Add
                </button>
            </form>`;
    }

    renderRow(work, esc) {
        if (work.id === this.editingId) {
            return `
                <div class="tk-work-row tk-work-row-edit" data-work-id="${work.id}">
                    <textarea class="works-edit-input tk-input text-sm" autocomplete="off" rows="3">${esc(work.text)}</textarea>
                    <div class="flex flex-shrink-0 gap-1">
                        <button type="button" class="works-save tk-btn tk-btn-primary tk-btn-sm">Save</button>
                        <button type="button" class="works-cancel tk-btn tk-btn-secondary tk-btn-sm">Cancel</button>
                    </div>
                </div>`;
        }

        return `
            <div class="tk-work-row" data-work-id="${work.id}">
                <span class="tk-work-text">${esc(work.text)}</span>
                <div class="tk-work-actions">
                    <button type="button" class="works-edit tk-btn tk-btn-secondary tk-btn-sm">Edit</button>
                    <button type="button" class="works-delete tk-btn tk-btn-danger tk-btn-sm">Delete</button>
                </div>
            </div>`;
    }

    /** Re-render and put the caret back where the user left it. */
    renderPreservingFocus() {
        const active = document.activeElement;
        const wasAdding = active && active.classList.contains('works-add-input');
        const value = wasAdding ? active.value : null;

        this.render();

        if (wasAdding) {
            const input = this.container.querySelector('.works-add-input');
            if (input) {
                input.value = value;
                input.focus();
                this.updateAddButton();
            }
        } else if (this.editingId != null) {
            const input = this.container.querySelector('.works-edit-input');
            if (input) {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }
        }
    }

    // ---- events ------------------------------------------------------------

    handleClick(e) {
        const retry = e.target.closest('.works-retry');
        if (retry) {
            this.load();
            return;
        }

        const row = e.target.closest('[data-work-id]');
        if (!row) return;
        const id = Number(row.dataset.workId);

        if (e.target.closest('.works-edit')) {
            this.editingId = id;
            this.render();
            const input = this.container.querySelector('.works-edit-input');
            if (input) {
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
            }
            return;
        }

        if (e.target.closest('.works-cancel')) {
            this.editingId = null;
            this.render();
            return;
        }

        if (e.target.closest('.works-save')) {
            this.handleSave(id);
            return;
        }

        const deleteButton = e.target.closest('.works-delete');
        if (deleteButton) {
            this.handleDeleteClick(deleteButton, id);
        }
    }

    handleKeydown(e) {
        if (e.target.classList.contains('works-edit-input')) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.handleSave(Number(e.target.closest('[data-work-id]').dataset.workId));
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.editingId = null;
                this.render();
            }
        }
    }

    /** Enable Add only when the shared textarea contains meaningful text. */
    updateAddButton() {
        const input = this.container.querySelector('.works-add-input');
        const button = this.container.querySelector('.works-add-button');
        if (input && button) button.disabled = !input.value.trim() || this.clientId == null;
    }

    async handleAdd() {
        const input = this.container.querySelector('.works-add-input');
        if (!input) return;

        const text = input.value.trim();
        if (!text) {
            this.api.showToast('Enter something to add.', 'warning');
            input.focus();
            return;
        }
        if (this.clientId == null) return;

        try {
            // quiet: this module renders the failure itself, and a rejected
            // duplicate is an ordinary outcome rather than an error worth the
            // red toast fetchFromAPI would otherwise raise on a write.
            const work = await this.api.fetchFromAPI('/api/works', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: this.date, client_id: this.clientId, text }),
            }, { quiet: true });
            this.works.push(work);
            this.render();
            const fresh = this.container.querySelector('.works-add-input');
            if (fresh && (this.autoFocus || document.activeElement === document.body)) fresh.focus();
            this.onChange();
        } catch (error) {
            // A rejected duplicate deliberately leaves the text in the box: the
            // user is most likely about to reword it rather than abandon it.
            this.api.showToast(this.errorText(error, 'Could not add that work.'), 'warning');
            const fresh = this.container.querySelector('.works-add-input');
            if (fresh) {
                fresh.value = text;
                fresh.focus();
                this.updateAddButton();
            }
        }
    }

    async handleSave(id) {
        const input = this.container.querySelector('.works-edit-input');
        if (!input) return;

        const text = input.value.trim();
        if (!text) {
            this.api.showToast('A work cannot be empty.', 'warning');
            input.focus();
            return;
        }

        const existing = this.works.find((w) => w.id === id);
        if (existing && existing.text === text) {
            this.editingId = null;
            this.render();
            return;
        }

        try {
            const updated = await this.api.fetchFromAPI(`/api/works/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            }, { quiet: true });
            const index = this.works.findIndex((w) => w.id === id);
            if (index !== -1) this.works[index] = updated;
            this.editingId = null;
            this.render();
            this.onChange();
        } catch (error) {
            this.api.showToast(this.errorText(error, 'Could not save that work.'), 'warning');
            const stillThere = this.container.querySelector('.works-edit-input');
            if (stillThere) stillThere.focus();
        }
    }

    /** Click-twice-to-confirm, matching the delete buttons elsewhere. */
    handleDeleteClick(button, id) {
        confirmAction(button, () => this.handleDelete(id));
    }

    async handleDelete(id) {
        try {
            await this.api.fetchFromAPI(`/api/works/${id}`, { method: 'DELETE' }, { quiet: true });
            this.works = this.works.filter((w) => w.id !== id);
            if (this.editingId === id) this.editingId = null;
            this.render();
            this.onChange();
        } catch (error) {
            console.error('Failed to delete work:', error);
            this.api.showToast('Could not delete that work.', 'error');
        }
    }

    /**
     * fetchFromAPI surfaces the server's own message for a 4xx, which for works
     * is the duplicate rejection the user most needs to see. Anything else (a
     * timeout, a 500, the server being down) gets the generic text — its
     * message is diagnostic rather than actionable.
     */
    errorText(error, fallback) {
        const isClientError = error && error.status >= 400 && error.status < 500;
        const message = error && error.message ? String(error.message).trim() : '';
        return isClientError && message ? message : fallback;
    }

    /** Overridable hook: the owning page uses it to refresh dependent UI. */
    onChange() {}
}
