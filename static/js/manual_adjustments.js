import {
    confirmAction,
    disarmConfirm,
    lockBodyScroll,
    setHtml,
    setText,
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
        this.baseHours = document.getElementById('adjust-time-base-hours');
        this.baseMinuteField = document.getElementById('adjust-time-base-minutes');
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
        this.deltaOperator.addEventListener('click', () => this.toggleDeltaSign());
        this.deltaHours.addEventListener('input', () => this.syncFromDelta());
        this.deltaMinutesField.addEventListener('input', () => this.syncFromDelta());
        this.totalHours.addEventListener('input', () => this.syncFromTotal());
        this.totalMinutes.addEventListener('input', () => this.syncFromTotal());
        this.roundedHours?.addEventListener('input', () => this.syncFromRounded());
        this.roundedHours?.addEventListener('change', () => this.syncFromRounded(true));
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
        this.modal.addEventListener('click', (event) => {
            if (event.target === this.modal) this.close();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.isOpen()) this.close();
        });
    }

    isOpen() {
        return Boolean(this.modal && !this.modal.classList.contains('hidden'));
    }

    async open() {
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
        this.panel?.focus();
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
        this.clientPicker = new Choices(this.client, {
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
        this.setDeltaSign(1);
        setText(this.difference, '—');
        this.setRoundingTone(0);
        this.rounded?.classList.toggle('hidden', !this.owner.roundingEnabled);
        setText(
            this.help,
            this.owner.roundingEnabled
                ? 'Edit the adjustment, adjusted time, or rounded hours; the other values recalculate automatically.'
                : 'With rounding off, adjusted time is used directly.'
        );
        this.save.disabled = true;
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
        this.deltaHours.focus();
        this.deltaHours.select();
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

    toggleDeltaSign() {
        this.setDeltaSign(this.deltaSign * -1);
        if (Number.isFinite(this.deltaMinutes())) this.syncFromDelta();
        else this.renderResult();
    }

    renderResult({ preserveRoundedInput = false } = {}) {
        this.clearError();
        const clientId = this.clientId();
        const delta = this.deltaMinutes();
        const adjusted = this.adjustedMinutes();
        const wholeDelta = Number.isInteger(delta);
        const calculable = clientId != null
            && Number.isFinite(adjusted)
            && adjusted >= 0
            && wholeDelta;

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
    }

    clearBaseTime() {
        setText(this.baseHours, '—');
        setText(this.baseMinuteField, '—');
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
