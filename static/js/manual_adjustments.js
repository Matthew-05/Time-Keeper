import {
    confirmAction,
    disarmConfirm,
    makeModalBackdropStatic,
    lockBodyScroll,
    setHtml,
    setText,
    setRequiredState,
    createChoices,
    unlockBodyScroll,
} from './base.js';


/** CRUD controller for the History page's client-day manual adjustments. */
export class ManualAdjustmentManager {
    constructor(owner) {
        this.owner = owner;
        this.modal = document.getElementById('adjust-time-modal');
        if (!this.modal) return;

        this.panel = document.getElementById('adjust-time-panel');
        this.subtitle = document.getElementById('adjust-time-subtitle');
        this.client = document.getElementById('adjust-time-client');
        this.clientField = document.getElementById('adjust-time-client-field');
        this.changeField = document.getElementById('adjust-time-change-field');
        this.baseHours = document.getElementById('adjust-time-base-hours');
        this.baseMinuteField = document.getElementById('adjust-time-base-minutes');
        this.baseDisplay = document.getElementById('adjust-time-base-display');
        this.valueInput = document.getElementById('adjust-time-value');
        this.valueLabelText = document.getElementById('adjust-time-value-label-text');
        this.modeToggle = document.getElementById('adjust-time-mode-toggle');
        this.modeToggleLabel = document.getElementById('adjust-time-mode-toggle-label');
        this.preview = document.getElementById('adjust-time-preview');
        this.previewTimeRow = document.getElementById('adjust-time-preview-time-row');
        this.previewTimeLabel = document.getElementById('adjust-time-preview-time-label');
        this.previewTime = document.getElementById('adjust-time-preview-time');
        this.previewDelta = document.getElementById('adjust-time-preview-delta');
        this.deltaOperator = document.getElementById('adjust-time-operator');
        this.deltaHours = document.getElementById('adjust-time-delta-hours');
        this.deltaMinutesField = document.getElementById('adjust-time-delta-minutes');
        this.deltaSign = 1;
        this.totalHours = document.getElementById('adjust-time-total-hours');
        this.totalMinutes = document.getElementById('adjust-time-total-minutes');
        this.difference = document.getElementById('adjust-time-difference');
        this.rounded = document.getElementById('adjust-time-rounded');
        this.roundedHours = document.getElementById('adjust-time-rounded-hours');
        this.help = document.getElementById('adjust-time-help');
        this.error = document.getElementById('adjust-time-error');
        this.list = document.getElementById('adjust-time-list');
        this.deleteButton = document.getElementById('adjust-time-delete');
        this.save = document.getElementById('adjust-time-save');
        this.current = null;
        this.baseMinutes = null;
        this.requestToken = 0;

        this.configureDurationInput();
        globalThis.customElements?.whenDefined?.('input-duration').then(() => {
            this.configureDurationInput();
            this.updateEditorView();
        });

        this.restrictNumberInput(this.deltaHours, { integer: true });
        this.restrictNumberInput(this.deltaMinutesField, { integer: true, max: 59 });
        this.restrictNumberInput(this.totalHours, { integer: true });
        this.restrictNumberInput(this.totalMinutes, { max: 59.999999 });
        this.restrictNumberInput(this.roundedHours);

        document.getElementById('adjust-time-btn')
            .addEventListener('click', () => this.open());
        document.getElementById('adjust-time-close')
            .addEventListener('click', () => this.close());
        document.getElementById('adjust-time-cancel')
            .addEventListener('click', () => this.close());
        this.client.addEventListener('change', () => this.selectClient());
        this.modeToggle?.addEventListener('click', () => this.toggleEditMode());
        this.deleteButton?.addEventListener('click', () => {
            const adjustment = this.current;
            if (!adjustment) return;
            confirmAction(
                this.deleteButton,
                () => this.deleteAdjustment(adjustment),
                { label: 'Confirm delete?' },
            );
        });
        this.save.addEventListener('click', () => this.submit());
        this.list.addEventListener('click', (event) => {
            const button = event.target.closest(
                '[data-edit-adjustment-id], [data-delete-adjustment-id]'
            );
            if (!button) return;
            const row = this.adjustments.find(
                adjustment => adjustment.id === Number(
                    button.dataset.editAdjustmentId
                    || button.dataset.deleteAdjustmentId
                )
            );
            if (!row) return;
            if (button.dataset.deleteAdjustmentId) {
                confirmAction(button, () => this.deleteAdjustment(row), {
                    label: 'Confirm?',
                });
                return;
            }
            this.edit(row);
        });
        makeModalBackdropStatic(this.modal);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.isOpen()) this.close();
        });
    }

    isOpen() {
        return Boolean(this.modal && !this.modal.classList.contains('hidden'));
    }

    async open({ adjustmentId = null } = {}) {
        const date = this.owner.selectedDate.value;
        setText(this.subtitle, this.owner.formatDateLong(date));
        this.clearError();

        try {
            const [clients, adjustments] = await Promise.all([
                this.owner.fetchFromAPI('/clients'),
                this.owner.fetchFromAPI(
                    `/api/manual-adjustments?date=${encodeURIComponent(date)}`
                ),
            ]);
            this.owner.clients = clients;
            this.owner.manualAdjustments = adjustments;
            this.adjustments = adjustments;
        } catch (error) {
            console.error('Could not load manual adjustments:', error);
            this.owner.showToast('Could not load manual adjustments', 'error');
            return;
        }

        this.initializeClientPicker();
        this.renderList();
        this.resetForm();
        this.modal.classList.remove('hidden');
        lockBodyScroll();
        const requested = adjustmentId == null
            ? null
            : this.adjustments.find(row => row.id === Number(adjustmentId));
        if (requested) this.edit(requested);
        else this.panel?.focus();
    }

    close() {
        if (!this.modal || !this.isOpen()) return;
        this.requestToken += 1;
        this.clientPicker?.destroy();
        this.clientPicker = null;
        this.modal.classList.add('hidden');
        unlockBodyScroll();
        this.owner.resumeRefresh();
    }

    initializeClientPicker() {
        this.clientPicker?.destroy();
        setHtml(
            this.client,
            this.owner.getClientOptions(null, { placeholder: 'Choose a client…' })
        );
        this.clientPicker = createChoices(this.client, {
            searchPlaceholderValue: 'Start typing client name...',
            placeholder: true,
            placeholderValue: 'Choose a client…',
            searchResultLimit: 10,
            shouldSort: false,
            itemSelectText: '',
        });
    }

    resetForm() {
        this.current = null;
        this.baseMinutes = null;
        this.setDeleteAvailable(false);
        this.clientPicker?.removeActiveItems();
        this.client.value = '';
        this.clearBaseTime();
        this.clearDeltaTime();
        this.totalHours.value = '';
        this.totalMinutes.value = '';
        this.roundedHours.value = '';
        this.setDurationInputMinutes(0);
        this.editMode = this.owner.roundingEnabled ? 'rounded' : 'exact';
        this.setDeltaSign(1);
        setText(this.difference, '—');
        this.setRoundingTone(0);
        this.rounded?.classList.add('hidden');
        this.updateEditorView();
        this.save.disabled = true;
        this.syncRequiredStates();
        this.clearError();
    }

    clientId() {
        const value = Number(this.client.value);
        return Number.isInteger(value) && value > 0 ? value : null;
    }

    async selectClient() {
        const clientId = this.clientId();
        this.clearError();
        if (clientId == null) {
            this.resetForm();
            return;
        }

        const existing = this.adjustments.find(row => row.client_id === clientId);
        if (existing) {
            this.populate(existing);
            return;
        }

        const token = ++this.requestToken;
        this.current = null;
        this.setDeleteAvailable(false);
        this.save.disabled = true;
        try {
            const total = await this.owner.fetchFromAPI(
                `/api/client-day-total/${this.owner.selectedDate.value}/${clientId}`
            );
            if (token !== this.requestToken) return;
            this.baseMinutes = this.normalizedBaseMinutes(
                total.base_minutes, total.has_running_task
            );
            this.setBaseMinutes(this.baseMinutes);
            this.setDeltaMinutes(0);
            this.setAdjustedMinutes(this.baseMinutes);
            this.renderResult();
        } catch (error) {
            if (token !== this.requestToken) return;
            this.showError('Could not load this client’s total.');
        }
    }

    populate(adjustment) {
        this.requestToken += 1;
        this.current = adjustment;
        this.setDeleteAvailable(true);
        this.baseMinutes = this.normalizedBaseMinutes(
            adjustment.base_minutes, adjustment.has_running_task
        );
        this.setBaseMinutes(this.baseMinutes);
        this.setDeltaMinutes(adjustment.adjustment_minutes);
        this.setAdjustedMinutes(Number(adjustment.adjusted_minutes));
        this.renderResult();
    }

    edit(adjustment) {
        this.clientPicker?.setChoiceByValue(String(adjustment.client_id));
        this.populate(adjustment);
        this.focusDurationInput();
    }

    syncFromDelta() {
        if (this.baseMinutes == null) return this.renderResult();
        const delta = this.deltaMinutes();
        if (Number.isFinite(delta) && this.baseMinutes + delta >= 0) {
            this.setAdjustedMinutes(this.baseMinutes + delta);
        }
        else this.clearAdjustedTime();
        this.renderResult();
    }

    syncFromTotal() {
        if (this.baseMinutes == null) return this.renderResult();
        const total = this.adjustedMinutes();
        if (Number.isFinite(total)) this.setDeltaMinutes(total - this.baseMinutes);
        else this.clearDeltaTime();
        this.renderResult();
    }

    /**
     * Use rounded hours as the third authoring path. The entered value always
     * snaps to the nearest configured interval, even when the policy itself
     * rounds raw time up or down. The stored adjustment remains a whole number
     * of minutes, so choose the closest reachable adjusted time that the active
     * policy maps back to the requested rounded target.
     */
    syncFromRounded(commit = false) {
        if (this.baseMinutes == null) {
            return this.renderResult({ preserveRoundedInput: true });
        }

        const target = this.roundedTargetMinutes();
        if (!Number.isFinite(target)) {
            this.clearDeltaTime();
            this.clearAdjustedTime();
            return this.renderResult({ preserveRoundedInput: true });
        }

        const adjustment = this.adjustmentForRoundedMinutes(target);
        if (adjustment == null) {
            this.clearDeltaTime();
            this.clearAdjustedTime();
            return this.renderResult({ preserveRoundedInput: true });
        }

        if (commit) this.setRoundedMinutes(target);
        this.setDeltaMinutes(adjustment);
        this.setAdjustedMinutes(this.baseMinutes + adjustment);
        this.renderResult({ preserveRoundedInput: true });
    }

    /**
     * Author the adjustment through the modal's segmented duration control.
     * Rounded mode finds an exact minute total which produces the requested
     * rounded result; exact mode writes the unrounded total directly.
     */
    syncFromAuthorValue(commit = false) {
        if (!this.valueInput) return;
        const target = this.parseDurationInput(this.valueInput.value);
        const roundedMode = this.editMode === 'rounded' && this.owner.roundingEnabled;

        if (this.baseMinutes == null || !Number.isFinite(target)) {
            this.clearDeltaTime();
            this.clearAdjustedTime();
            this.renderResult({
                preserveRoundedInput: roundedMode,
                preserveAuthorInput: true,
            });
            if (commit) {
                this.showError('Enter valid hours and minutes.');
            }
            return;
        }

        if (roundedMode) {
            const interval = this.roundingIntervalMinutes();
            const roundedTarget = Math.floor(target / interval + 0.5) * interval;
            const adjustment = this.adjustmentForRoundedMinutes(roundedTarget);
            if (adjustment == null) {
                this.clearDeltaTime();
                this.clearAdjustedTime();
                this.renderResult({ preserveRoundedInput: true, preserveAuthorInput: true });
                if (commit) this.showError('That rounded duration cannot be produced by the current policy.');
                return;
            }
            this.setRoundedMinutes(roundedTarget);
            this.setDeltaMinutes(adjustment);
            this.setAdjustedMinutes(this.baseMinutes + adjustment);
            if (commit) this.setDurationInputMinutes(roundedTarget);
        } else {
            this.setAdjustedMinutes(target);
            this.setDeltaMinutes(target - this.baseMinutes);
            if (commit) this.setDurationInputMinutes(target);
        }

        this.renderResult({
            preserveRoundedInput: roundedMode,
            preserveAuthorInput: true,
        });
    }

    toggleEditMode() {
        if (!this.owner.roundingEnabled) return;
        this.editMode = this.editMode === 'rounded' ? 'exact' : 'rounded';
        this.updateEditorView();
        this.focusDurationInput();
    }

    /** Parse library values plus the legacy friendly duration forms. */
    parseDurationInput(value) {
        const text = String(value ?? '').trim().toLowerCase().replace(',', '.');
        if (!text) return Number.NaN;

        const clock = text.match(/^(\d+):([0-5]?\d)(?::[0-5]?\d(?:\.\d{1,3})?)?$/);
        if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

        if (/^\d+(?:\.\d+)?$/.test(text)) {
            return Math.round(Number(text) * 60);
        }

        const words = text.match(
            /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes))?$/
        );
        if (!words || (words[1] == null && words[2] == null)) return Number.NaN;
        const minutes = Number(words[1] || 0) * 60 + Number(words[2] || 0);
        return Number.isFinite(minutes) && minutes >= 0
            ? Math.round(minutes)
            : Number.NaN;
    }

    formatDurationInput(totalMinutes) {
        const safe = Math.max(0, Math.round(Number(totalMinutes) || 0));
        const hours = Math.floor(safe / 60);
        const minutes = safe % 60;
        if (hours && minutes) return `${hours}h ${minutes}m`;
        if (hours) return `${hours}h`;
        return `${minutes}m`;
    }

    /** Theme and trim the library's open shadow root to the two units we use. */
    configureDurationInput() {
        const root = this.valueInput?.shadowRoot;
        if (!root || this.valueInput.dataset.timeKeeperReady === 'true') return;
        this.valueInput.dataset.timeKeeperReady = 'true';
        this.valueInput.tabIndex = -1;

        const hours = root.querySelector('input.sH');
        const minutes = root.querySelector('input.sM');
        const seconds = root.querySelector('input.sS');
        const milliseconds = root.querySelector('input.sMS');
        const hourUnit = root.querySelector('.bds-h');
        const minuteUnit = root.querySelector('.bds-m');
        const hiddenSeparator = root.querySelector('.bds-s');
        const icon = root.querySelector('#svgContainer');

        hourUnit.textContent = 'hrs';
        minuteUnit.textContent = 'mins';
        hours.setAttribute('aria-label', 'Hours');
        minutes.setAttribute('aria-label', 'Minutes');
        seconds.hidden = true;
        milliseconds.hidden = true;
        hiddenSeparator.hidden = true;
        icon.hidden = true;

        const sync = () => this.syncFromAuthorValue();
        const commit = () => this.syncFromAuthorValue(true);
        const bindSegment = (input, max) => {
            let lastValid = input.value;
            input.addEventListener('input', () => {
                const numeric = Number(input.value);
                if (input.value === '' || (/^\d{1,2}$/.test(input.value) && numeric <= max)) {
                    lastValid = input.value;
                } else if (numeric === max + 1) {
                    input.value = '00';
                    lastValid = input.value;
                } else if (numeric === -1) {
                    input.value = String(max);
                    lastValid = input.value;
                } else {
                    input.value = lastValid;
                }
                sync();
            });
            input.addEventListener('change', commit);
        };
        bindSegment(hours, 99);
        bindSegment(minutes, 59);

        // The package advances from minutes into its seconds field. Seconds are
        // intentionally hidden here, so keep right-arrow and two-digit entry in
        // the visible minutes segment.
        minutes.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowRight') event.stopPropagation();
        });
        minutes.addEventListener('keyup', (event) => {
            if (/^\d$/.test(event.key)) event.stopImmediatePropagation();
        }, true);

        const style = document.createElement('style');
        style.textContent = `
            div.timeCase {
                align-items: center;
                background: var(--duration-background);
                border: 1px solid var(--duration-border);
                border-radius: 8px;
                box-sizing: border-box;
                display: flex;
                gap: 0.42rem;
                max-width: none;
                min-height: 3rem;
                padding: 0.55rem 0.75rem;
                transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
                width: 100%;
            }
            div.timeCase:focus-within {
                border: 1px solid var(--duration-border);
                box-shadow: 0 0 0 3px var(--ring);
                padding: 0.55rem 0.75rem;
            }
            div.timeCase input.ts_digit {
                appearance: textfield;
                background: transparent;
                border: 0;
                border-radius: 4px;
                caret-color: auto;
                color: var(--duration-text);
                font: inherit;
                font-size: 1.125rem;
                font-variant-numeric: tabular-nums;
                font-weight: 650;
                line-height: 1.35;
                padding: 0.12rem 0.2rem;
                text-align: right;
                width: 2.8ch;
            }
            div.timeCase input.ts_digit:hover,
            div.timeCase input.ts_digit:focus {
                background: var(--accent-soft);
            }
            div.timeCase input.ts_digit:focus {
                box-shadow: inset 0 0 0 1px var(--accent);
                outline: none;
            }
            .bds-h, .bds-m {
                color: var(--duration-separator);
                font-size: 0.75rem;
                font-weight: 600;
                margin-right: 0.4rem;
            }
        `;
        root.append(style);
    }

    durationControlParts() {
        const root = this.valueInput?.shadowRoot;
        return {
            hours: root?.querySelector('input.sH') || null,
            minutes: root?.querySelector('input.sM') || null,
        };
    }

    setDurationInputMinutes(totalMinutes) {
        if (!this.valueInput) return;
        const safe = Math.max(0, Math.round(Number(totalMinutes) || 0));
        const hourValue = String(Math.floor(safe / 60)).padStart(2, '0');
        const minuteValue = String(safe % 60).padStart(2, '0');
        const parts = this.durationControlParts();
        if (parts.hours && parts.minutes) {
            parts.hours.value = hourValue;
            parts.minutes.value = minuteValue;
        } else {
            this.valueInput.value = `${hourValue}:${minuteValue}:00.000`;
        }
    }

    focusDurationInput() {
        const hours = this.durationControlParts().hours;
        if (hours) {
            hours.focus();
            hours.select();
        } else {
            this.valueInput?.focus?.();
        }
    }

    toggleDeltaSign() {
        this.setDeltaSign(this.deltaSign * -1);
        if (Number.isFinite(this.deltaMinutes())) this.syncFromDelta();
        else this.renderResult();
    }

    renderResult({ preserveRoundedInput = false, preserveAuthorInput = false } = {}) {
        this.clearError();
        const clientId = this.clientId();
        const delta = this.deltaMinutes();
        const adjusted = this.adjustedMinutes();
        const wholeDelta = Number.isInteger(delta);
        const calculable = clientId != null
            && Number.isFinite(adjusted)
            && adjusted >= 0
            && wholeDelta;

        this.syncRequiredStates(clientId, delta);
        this.save.disabled = !calculable || delta === 0;
        if (!calculable) {
            this.rounded?.classList.toggle('hidden', !this.owner.roundingEnabled);
            if (!preserveRoundedInput) this.roundedHours.value = '';
            setText(this.difference, '—');
            this.setRoundingTone(0);
            if (Number.isFinite(delta) && !wholeDelta) {
                this.showError('The adjustment must be a whole number of minutes.');
            } else if (
                Number.isFinite(delta)
                && this.baseMinutes != null
                && this.baseMinutes + delta < 0
            ) {
                this.showError('Adjusted time cannot be negative.');
            } else {
                const deltaHours = this.inputNumber(this.deltaHours);
                const deltaMinutes = this.inputNumber(this.deltaMinutesField);
                const totalHours = this.inputNumber(this.totalHours);
                const totalMinutes = this.inputNumber(this.totalMinutes);
                if (
                    Number.isFinite(deltaHours)
                    && (!Number.isInteger(deltaHours) || deltaHours < 0)
                ) {
                    this.showError('Adjustment hours must be a non-negative whole number.');
                } else if (
                    Number.isFinite(deltaMinutes)
                    && (!Number.isInteger(deltaMinutes) || deltaMinutes < 0 || deltaMinutes >= 60)
                ) {
                    this.showError('Adjustment minutes must be between 0 and 59.');
                } else if (Number.isFinite(totalHours) && (!Number.isInteger(totalHours) || totalHours < 0)) {
                    this.showError('Hours must be a non-negative whole number.');
                } else if (Number.isFinite(totalMinutes) && (totalMinutes < 0 || totalMinutes >= 60)) {
                    this.showError('Minutes must be between 0 and 59.');
                }
            }
            this.updateEditorView({ preserveAuthorInput });
            return;
        }

        const billableMinutes = this.owner.totalTimeSpentToFractionalHours(adjusted) * 60;
        if (this.owner.roundingEnabled) {
            if (!preserveRoundedInput) this.setRoundedMinutes(billableMinutes);
            const roundingDifference = billableMinutes - adjusted;
            setText(this.difference, this.signedMinutes(roundingDifference));
            this.setRoundingTone(roundingDifference);
            this.rounded?.classList.remove('hidden');
        } else {
            this.setRoundingTone(0);
            this.rounded?.classList.add('hidden');
        }
        this.updateEditorView({ preserveAuthorInput });
    }

    /** Render context and calculated consequences around the one input. */
    updateEditorView({ preserveAuthorInput = false } = {}) {
        if (!this.valueInput) return;
        const roundedMode = this.editMode === 'rounded' && this.owner.roundingEnabled;
        const adjusted = this.adjustedMinutes();
        const delta = this.deltaMinutes();
        const calculable = this.clientId() != null
            && Number.isFinite(adjusted)
            && adjusted >= 0
            && Number.isInteger(delta);
        const billable = calculable && this.owner.roundingEnabled
            ? this.owner.totalTimeSpentToFractionalHours(adjusted) * 60
            : adjusted;

        setText(this.valueLabelText, roundedMode ? 'Rounded time' : 'Exact time');
        this.valueInput.setAttribute(
            'aria-label',
            roundedMode ? 'Rounded adjusted duration' : 'Exact adjusted duration',
        );
        if (!preserveAuthorInput) {
            const target = roundedMode ? billable : adjusted;
            this.setDurationInputMinutes(Number.isFinite(target) ? target : 0);
        }

        this.modeToggle?.classList.toggle('hidden', !this.owner.roundingEnabled);
        const toggleLabel = roundedMode ? 'Edit exact' : 'Use rounded';
        const toggleTitle = roundedMode ? 'Edit exact time' : 'Edit rounded time';
        setText(this.modeToggleLabel, toggleLabel);
        this.modeToggle?.setAttribute('aria-label', toggleTitle);
        this.modeToggle?.setAttribute('title', toggleTitle);

        setText(
            this.help,
            roundedMode
                ? `Uses the ${this.roundingIntervalMinutes()}-minute rounding policy. Type a value or use the arrow keys.`
                : 'Directly edits unrounded time. Type a value or use the arrow keys.',
        );

        this.preview?.classList.toggle('hidden', !calculable);
        const showOtherTime = calculable && this.owner.roundingEnabled;
        this.previewTimeRow?.classList.toggle('hidden', !showOtherTime);
        setText(this.previewTimeLabel, roundedMode ? 'Exact time' : 'Rounded time');
        setText(
            this.previewTime,
            showOtherTime
                ? this.formatDurationInput(roundedMode ? adjusted : billable)
                : '—',
        );
        setText(this.previewDelta, calculable ? this.formatSignedDuration(delta) : '—');
        this.previewDelta?.classList.remove('text-success', 'text-danger', 'text-faint');
        this.previewDelta?.classList.add(
            !calculable || delta === 0 ? 'text-faint' : delta > 0 ? 'text-success' : 'text-danger',
        );
    }

    /** Show the two actual prerequisites without marking six linked inputs. */
    syncRequiredStates(clientId = this.clientId(), delta = this.deltaMinutes()) {
        setRequiredState(this.clientField, clientId == null);
        setRequiredState(
            this.changeField,
            clientId == null || !Number.isFinite(delta) || delta === 0,
        );
    }

    async submit() {
        if (this.save.disabled) return;
        const payload = {
            adjustment_minutes: this.deltaMinutes(),
        };
        let url = '/api/manual-adjustments';
        let method = 'POST';
        if (this.current) {
            url += `/${this.current.id}`;
            method = 'PUT';
        } else {
            payload.date = this.owner.selectedDate.value;
            payload.client_id = this.clientId();
        }

        this.save.disabled = true;
        try {
            const saved = await this.owner.fetchFromAPI(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            await this.reload();
            this.edit(saved);
            await this.owner.fetchTasks();
            this.owner.showToast('Manual adjustment saved', 'success');
        } catch (error) {
            this.showError(error.message || 'Could not save the adjustment.');
            this.save.disabled = false;
        }
    }

    async deleteAdjustment(adjustment) {
        try {
            await this.owner.fetchFromAPI(
                `/api/manual-adjustments/${adjustment.id}`,
                { method: 'DELETE' }
            );
            await this.reload();
            if (this.current?.id === adjustment.id) this.resetForm();
            await this.owner.fetchTasks();
            this.owner.showToast('Manual adjustment deleted', 'success');
        } catch (error) {
            this.showError(error.message || 'Could not delete the adjustment.');
        }
    }

    setDeleteAvailable(available) {
        if (!this.deleteButton) return;
        if (!available) disarmConfirm(this.deleteButton);
        this.deleteButton.classList.toggle('hidden', !available);
    }

    async reload() {
        const rows = await this.owner.fetchFromAPI(
            `/api/manual-adjustments?date=${encodeURIComponent(this.owner.selectedDate.value)}`
        );
        this.adjustments = rows;
        this.owner.manualAdjustments = rows;
        this.renderList();
    }

    renderList() {
        if (!this.adjustments.length) {
            const columns = this.owner.roundingEnabled ? 6 : 4;
            setHtml(this.list, `<tr><td colspan="${columns}" class="tk-empty">No manual adjustments on this date.</td></tr>`);
            return;
        }
        setHtml(this.list, this.adjustments.map(adjustment => {
            const adjustedMinutes = Number(adjustment.adjusted_minutes);
            const billableMinutes = Number(adjustment.billable_minutes);
            const roundingDifference = Math.round(billableMinutes - adjustedMinutes);
            const differenceClass = roundingDifference === 0
                ? 'text-faint'
                : roundingDifference > 0 ? 'text-success' : 'text-danger';
            const difference = roundingDifference === 0
                ? '—'
                : `${roundingDifference > 0 ? '+' : '−'}${Math.abs(roundingDifference)}m`;

            return `
            <tr>
                <td class="font-medium">${this.owner.escapeHtml(adjustment.client_name)}</td>
                <td class="tk-num ${adjustment.adjustment_minutes < 0 ? 'text-danger' : adjustment.adjustment_minutes > 0 ? 'text-success' : 'text-faint'}">
                    ${this.formatSignedDuration(adjustment.adjustment_minutes)}
                </td>
                <td class="tk-num">${this.owner.formatDurationMinutes(adjustment.adjusted_minutes)}</td>
                ${this.owner.roundingEnabled ? `
                    <td class="tk-num whitespace-nowrap font-semibold">
                        ${this.owner.formatDecimalHours(billableMinutes / 60)} <span class="font-normal text-faint">hrs.</span>
                    </td>
                    <td class="tk-num ${differenceClass}">${difference}</td>
                ` : ''}
                <td class="tk-num">
                    <div class="tk-adjustment-actions">
                        <button type="button" class="tk-btn tk-btn-secondary tk-btn-sm" data-edit-adjustment-id="${adjustment.id}">Edit</button>
                        <button type="button" class="tk-btn tk-btn-danger tk-btn-sm" data-delete-adjustment-id="${adjustment.id}">Delete</button>
                    </div>
                </td>
            </tr>
        `;
        }).join(''));
    }

    formatSignedDuration(minutes) {
        const rounded = Math.round(Number(minutes) * 100) / 100;
        if (rounded === 0) return '0 mins';
        return `${rounded > 0 ? '+' : '−'}${this.owner.formatDurationMinutes(Math.abs(rounded))}`;
    }

    numberValue(value) {
        const rounded = Math.round(Number(value) * 100) / 100;
        return Number.isInteger(rounded) ? String(rounded) : String(rounded);
    }

    roundingIntervalMinutes() {
        const interval = Number(this.owner.roundingIntervalMinutes);
        return Number.isInteger(interval) && interval >= 1 && interval <= 60
            ? interval
            : 15;
    }

    roundedTargetMinutes() {
        const hours = this.inputNumber(this.roundedHours);
        if (!Number.isFinite(hours) || hours < 0) return Number.NaN;
        const interval = this.roundingIntervalMinutes();
        return Math.floor(hours * 60 / interval + 0.5) * interval;
    }

    setRoundedMinutes(totalMinutes) {
        const hours = Math.max(0, Number(totalMinutes) || 0) / 60;
        this.roundedHours.value = Number(hours.toFixed(6)).toString();
    }

    setRoundingTone(minutes) {
        const fields = [this.roundedHours, this.difference];
        fields.forEach(field => field?.classList.remove('text-success', 'text-danger'));
        if (minutes > 1e-7) {
            fields.forEach(field => field?.classList.add('text-success'));
        } else if (minutes < -1e-7) {
            fields.forEach(field => field?.classList.add('text-danger'));
        }
    }

    adjustmentForRoundedMinutes(targetMinutes) {
        const center = targetMinutes - this.baseMinutes;
        const radius = this.roundingIntervalMinutes() + 2;
        let best = null;

        for (
            let adjustment = Math.floor(center - radius);
            adjustment <= Math.ceil(center + radius);
            adjustment += 1
        ) {
            const adjusted = this.baseMinutes + adjustment;
            if (adjusted < 0) continue;
            const rounded = this.owner.totalTimeSpentToFractionalHours(adjusted) * 60;
            if (Math.abs(rounded - targetMinutes) > 1e-7) continue;

            const score = [Math.abs(adjusted - targetMinutes), Math.abs(adjustment)];
            if (
                best == null
                || score[0] < best.score[0]
                || (score[0] === best.score[0] && score[1] < best.score[1])
            ) {
                best = { adjustment, score };
            }
        }

        return best?.adjustment ?? null;
    }

    normalizedBaseMinutes(value, hasRunningTask = false) {
        const minutes = Math.max(0, Number(value) || 0);
        return hasRunningTask ? Math.floor(minutes) : minutes;
    }

    inputNumber(input) {
        if (!input || input.value.trim() === '') return Number.NaN;
        return Number(input.value);
    }

    /** Keep invalid characters and pasted values out of numeric controls. */
    restrictNumberInput(input, { integer = false, max = null } = {}) {
        if (!input) return;
        const blockedKeys = new Set(['-', '+', 'e', 'E']);
        if (integer) blockedKeys.add('.').add(',');

        input.addEventListener('focus', () => {
            input.dataset.lastAcceptedNumber = input.value;
        });
        input.addEventListener('keydown', (event) => {
            if (blockedKeys.has(event.key)) event.preventDefault();
        });
        input.addEventListener('input', () => {
            if (input.value === '') {
                input.dataset.lastAcceptedNumber = '';
                return;
            }
            const value = Number(input.value);
            const accepted = Number.isFinite(value)
                && value >= 0
                && (!integer || Number.isInteger(value))
                && (max == null || value <= max);
            if (!accepted) {
                input.value = input.dataset.lastAcceptedNumber ?? '';
                return;
            }
            input.dataset.lastAcceptedNumber = input.value;
        });
    }

    deltaMinutes() {
        const hours = this.inputNumber(this.deltaHours);
        const minutes = this.inputNumber(this.deltaMinutesField);
        if (
            !Number.isInteger(hours)
            || hours < 0
            || !Number.isInteger(minutes)
            || minutes < 0
            || minutes >= 60
        ) {
            return Number.NaN;
        }
        return this.deltaSign * (hours * 60 + minutes);
    }

    setDeltaMinutes(totalMinutes) {
        const numeric = Number(totalMinutes) || 0;
        this.setDeltaSign(numeric < 0 ? -1 : 1);
        const magnitude = Math.abs(numeric);
        this.deltaHours.value = String(Math.floor(magnitude / 60));
        this.deltaMinutesField.value = this.numberValue(magnitude % 60);
    }

    setDeltaSign(sign) {
        this.deltaSign = sign < 0 ? -1 : 1;
        const symbol = this.deltaSign < 0 ? '−' : '+';
        setText(this.deltaOperator, symbol);
        this.deltaOperator?.setAttribute(
            'aria-label',
            this.deltaSign < 0 ? 'Use a negative adjustment' : 'Use a positive adjustment'
        );
        this.deltaOperator?.setAttribute(
            'aria-pressed',
            this.deltaSign < 0 ? 'true' : 'false'
        );
        this.deltaOperator?.setAttribute(
            'title',
            this.deltaSign < 0
                ? 'Subtracting time; click to add'
                : 'Adding time; click to subtract'
        );
    }

    clearDeltaTime() {
        this.deltaHours.value = '';
        this.deltaMinutesField.value = '';
    }

    adjustedMinutes() {
        const hours = this.inputNumber(this.totalHours);
        const minutes = this.inputNumber(this.totalMinutes);
        if (
            !Number.isInteger(hours)
            || hours < 0
            || !Number.isFinite(minutes)
            || minutes < 0
            || minutes >= 60
        ) {
            return Number.NaN;
        }
        return hours * 60 + minutes;
    }

    setAdjustedMinutes(totalMinutes) {
        const safe = Math.max(0, Number(totalMinutes) || 0);
        const hours = Math.floor(safe / 60);
        const minutes = safe - hours * 60;
        this.totalHours.value = String(hours);
        this.totalMinutes.value = this.numberValue(minutes);
    }

    clearAdjustedTime() {
        this.totalHours.value = '';
        this.totalMinutes.value = '';
    }

    signedMinutes(minutes) {
        const rounded = Math.round(Number(minutes) || 0);
        if (rounded === 0) return '—';
        return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}m`;
    }

    setBaseMinutes(totalMinutes) {
        const safe = Math.max(0, Number(totalMinutes) || 0);
        const hours = Math.floor(safe / 60);
        const minutes = safe - hours * 60;
        setText(this.baseHours, String(hours));
        setText(this.baseMinuteField, this.numberValue(minutes));
        setText(this.baseDisplay, this.formatDurationInput(safe));
    }

    clearBaseTime() {
        setText(this.baseHours, '—');
        setText(this.baseMinuteField, '—');
        setText(this.baseDisplay, '—');
    }

    showError(message) {
        setText(this.error, message);
        this.error.classList.remove('hidden');
    }

    clearError() {
        setText(this.error, '');
        this.error.classList.add('hidden');
    }
}
