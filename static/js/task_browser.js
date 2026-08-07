import { TimeKeeper, ready, clientColor } from './base.js';
import { WorksList, fetchWorks, joinWorks } from './works.js';

export class TaskBrowser extends TimeKeeper {
    constructor() {
        super();
        this.isLoading = false;
        this.initializeElements();
        this.initializeWorksModal();
        this.initializeTimePicker();
        this.initializeDayTimePickers();
        // Floating this promise un-caught meant any failure during startup
        // aborted the chain silently and left the page on its placeholders.
        this.fetchInitialData().catch((error) => {
            console.error('Initial load failed:', error);
        });
        this.initializeTaskEditing();

        setInterval(() => {
            if (this.selectedDate.value === this.getLocalDateString()) {
                this.fetchTasks();
            }
        }, 60000);
    }

    initializeElements() {
        this.selectedDate = document.getElementById('selected-date');
        this.dayStartTime = document.getElementById('day-start-time');
        this.dayEndTime = document.getElementById('day-end-time');
        this.closeDayBtn = document.getElementById('close-day-btn');
        this.closeDayContainer = document.getElementById('close-day-container');
        
        // Action buttons
        this.dayStartActions = document.getElementById('day-start-actions');
        this.dayEndActions = document.getElementById('day-end-actions');
        this.saveStartBtn = document.getElementById('save-start-time');
        this.cancelStartBtn = document.getElementById('cancel-start-time');
        this.saveEndBtn = document.getElementById('save-end-time');
        this.cancelEndBtn = document.getElementById('cancel-end-time');
        
        // Store original values
        this.originalStartTime = '';
        this.originalEndTime = '';
        
        this.datePicker = flatpickr(this.selectedDate, {
            defaultDate: new Date(),
            dateFormat: "Y-m-d",
            onChange: () => this.fetchTasks()
        });

        // Prev/next day buttons
        this.prevDayBtn = document.getElementById('prev-day-btn');
        this.nextDayBtn = document.getElementById('next-day-btn');
        if (this.prevDayBtn) this.prevDayBtn.addEventListener('click', () => this.navigateDay(-1));
        if (this.nextDayBtn) this.nextDayBtn.addEventListener('click', () => this.navigateDay(1));

        // Bind action buttons
        this.closeDayBtn.addEventListener('click', () => this.handleCloseDay());
        this.saveStartBtn.addEventListener('click', () => this.handleSaveTime('start'));
        this.cancelStartBtn.addEventListener('click', () => this.handleCancelTime('start'));
        this.saveEndBtn.addEventListener('click', () => this.handleSaveTime('end'));
        this.cancelEndBtn.addEventListener('click', () => this.handleCancelTime('end'));
    }

    navigateDay(delta) {
        const current = this.selectedDate.value || this.getLocalDateString();
        const [y, m, d] = current.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        date.setDate(date.getDate() + delta);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const nextDateStr = `${year}-${month}-${day}`;
        // Use the active flatpickr instance (timePicker is created second and replaces datePicker on same element)
        const picker = this.timePicker || this.datePicker;
        if (picker) picker.setDate(nextDateStr, true);
        this.fetchTasks();
    }

    initializeDayTimePickers() {
        // Initialize time pickers with onChange to show action buttons
        this.dayStartTimePicker = flatpickr(this.dayStartTime, {
            enableTime: true,
            noCalendar: true,
            dateFormat: "h:i K",
            time_24hr: false,
            onChange: () => {
                this.showTimeActions('start');
            }
        });

        this.dayEndTimePicker = flatpickr(this.dayEndTime, {
            enableTime: true,
            noCalendar: true,
            dateFormat: "h:i K",
            time_24hr: false,
            onChange: () => {
                this.showTimeActions('end');
            }
        });
    }

    showTimeActions(type) {
        if (type === 'start') {
            this.dayStartActions.classList.remove('action-buttons-hidden');
            this.dayStartActions.classList.add('action-buttons-visible');
        } else if (type === 'end') {
            this.dayEndActions.classList.remove('action-buttons-hidden');
            this.dayEndActions.classList.add('action-buttons-visible');
        }
    }

    hideTimeActions(type) {
        if (type === 'start') {
            this.dayStartActions.classList.remove('action-buttons-visible');
            this.dayStartActions.classList.add('action-buttons-hidden');
        } else if (type === 'end') {
            this.dayEndActions.classList.remove('action-buttons-visible');
            this.dayEndActions.classList.add('action-buttons-hidden');
        }
    }

    async handleSaveTime(type) {
        const timeStr = type === 'start' ? this.dayStartTime.value : this.dayEndTime.value;
        
        if (!timeStr) {
            this.showToast('Please select a time', 'error');
            return;
        }

        try {
            const response = await this.fetchFromAPI('/update_day_time', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    date: this.selectedDate.value,
                    type: type,
                    time: timeStr
                })
            });

            if (response.success) {
                this.showToast(`Day ${type} time updated successfully`, 'success');
                
                // Update the original value and flatpickr default
                if (type === 'start') {
                    this.originalStartTime = timeStr;
                    this.dayStartTimePicker.setDate(timeStr, false);
                } else {
                    this.originalEndTime = timeStr;
                    this.dayEndTimePicker.setDate(timeStr, false);
                }
                
                // Hide action buttons
                this.hideTimeActions(type);
                
                // Refresh tasks to update calculations
                await this.fetchTasks();
            }
        } catch (error) {
            this.showToast(`Failed to update day ${type} time`, 'error');
        }
    }

    handleCancelTime(type) {
        // Revert to original value
        if (type === 'start') {
            this.dayStartTime.value = this.originalStartTime;
            this.dayStartTimePicker.setDate(this.originalStartTime);
        } else {
            this.dayEndTime.value = this.originalEndTime;
            this.dayEndTimePicker.setDate(this.originalEndTime);
        }
        
        // Hide action buttons
        this.hideTimeActions(type);
    }

    async handleCloseDay() {
        try {
            // Check if there are unsaved changes
            const startChanged = this.dayStartActions.classList.contains('action-buttons-visible');
            const endChanged = this.dayEndActions.classList.contains('action-buttons-visible');
            
            if (startChanged || endChanged) {
                this.showToast('Please save or cancel pending time changes first', 'error');
                return;
            }

            // Get the end time to use for closing the day
            const endTimeStr = this.dayEndTime.value;
            if (!endTimeStr) {
                this.showToast('Please set an end time before closing the day', 'error');
                return;
            }

            // Call the end_day endpoint
            const response = await this.fetchFromAPI('/end_day', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time: endTimeStr })
            });

            if (response.message) {
                this.showToast('Day closed successfully', 'success');
                
                // Hide the close day button after closing
                this.closeDayContainer.classList.add('hidden');
                
                // Refresh tasks and summary
                await this.fetchTasks();
            }
        } catch (error) {
            this.showToast('Failed to close day', 'error');
        }
    }

    initializeTaskEditing() {
        document.addEventListener('click', e => {
            // Handle delete button clicks separately
            if (e.target.classList.contains('delete-task-btn')) {
                if (confirm('Are you sure you want to delete this task?')) {
                    this.handleTaskDelete(e.target.closest('tr'));
                }
                return; // Prevent event bubbling
            }

            // Handle other button clicks
            if (e.target.classList.contains('edit-task-btn')) {
                const row = e.target.closest('tr');
                this.enableEditMode(row);
            }
            if (e.target.classList.contains('save-task-btn')) {
                this.handleTaskUpdate(e.target.closest('tr'));
            }
            if (e.target.classList.contains('cancel-task-btn')) {
                this.disableEditMode(e.target.closest('tr'));
            }
        });
    }

    // ---- Works -------------------------------------------------------------

    initializeWorksModal() {
        this.worksModal = document.getElementById('works-modal');
        this.worksModalTitle = document.getElementById('works-modal-title');
        this.worksModalSubtitle = document.getElementById('works-modal-subtitle');
        if (!this.worksModal) return;

        this.worksModalClient = null;
        this.worksList = new WorksList({
            container: document.getElementById('works-modal-list'),
            api: this,
        });

        document.getElementById('works-modal-close')
            .addEventListener('click', () => this.closeWorksModal());
        document.getElementById('works-modal-done')
            .addEventListener('click', () => this.closeWorksModal());
        document.getElementById('works-modal-copy')
            .addEventListener('click', () => this.copyWorks(this.worksModalClient));

        // Click the backdrop, not the panel, to dismiss.
        this.worksModal.addEventListener('click', (e) => {
            if (e.target === this.worksModal) this.closeWorksModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.worksModal.classList.contains('hidden')) {
                this.closeWorksModal();
            }
        });
    }

    async openWorksModal(client) {
        if (!this.worksModal || client.id == null) return;

        const dateStr = this.selectedDate.value;
        this.worksModalClient = client;
        this.worksModalTitle.textContent = client.name;
        this.worksModalSubtitle.textContent = this.formatDateLong(dateStr);

        this.worksModal.classList.remove('hidden');
        // force: the same client can be reopened after an edit elsewhere, and
        // setTarget would otherwise treat an unchanged target as a no-op and
        // show a stale list.
        await this.worksList.setTarget(dateStr, client.id, { force: true });

        const input = this.worksModal.querySelector('.works-add-input');
        if (input) input.focus();
    }

    closeWorksModal() {
        if (!this.worksModal) return;
        this.worksModal.classList.add('hidden');
        this.worksModalClient = null;
    }

    /** Copy one client's works for the browsed day, comma-separated. */
    async copyWorks(client) {
        if (!client || client.id == null) return;

        try {
            const works = await fetchWorks(this, this.selectedDate.value, client.id);
            if (!works.length) {
                this.showToast(`No works recorded for ${client.name}`, 'warning');
                return;
            }
            await this.copyToClipboard(joinWorks(works));
        } catch (error) {
            console.error('Failed to copy works:', error);
            this.showToast('Could not load works to copy', 'error');
        }
    }

    formatDateLong(dateStr) {
        if (!dateStr) return '';
        // Parsed as local parts rather than via Date(dateStr), which reads a
        // bare YYYY-MM-DD as UTC and can render as the previous day.
        const [year, month, day] = dateStr.split('-').map(Number);
        return new Date(year, month - 1, day).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
        });
    }

    async handleTaskDelete(row) {
        const taskId = row.dataset.taskId;
        try {
            await this.fetchFromAPI(`/task/${taskId}`, {
                method: 'DELETE'
            });
            this.showToast('Task deleted successfully');
            await this.fetchTasks();
        } catch (error) {
            this.showToast('Failed to delete task', 'error');
        }
    }

    enableEditMode(row) {
        row.querySelectorAll('.time-display').forEach(span => span.classList.add('hidden'));
        row.querySelectorAll('.task-time-picker').forEach(input => input.classList.remove('hidden'));
        row.querySelector('.edit-task-btn').classList.add('hidden');
        row.querySelector('.edit-controls').classList.remove('hidden');
    }

    disableEditMode(row) {
        row.querySelectorAll('.time-display').forEach(span => span.classList.remove('hidden'));
        row.querySelectorAll('.task-time-picker').forEach(input => input.classList.add('hidden'));
        row.querySelector('.edit-task-btn').classList.remove('hidden');
        row.querySelector('.edit-controls').classList.add('hidden');
    }

    async handleTaskUpdate(row) {
        const taskId = row.dataset.taskId;
        const startTime = row.querySelector('.start-time').value;
        const endTime = row.querySelector('.end-time').value;
        const rawClientId = row.querySelector('.client-select').value;
        const clientId = parseInt(rawClientId, 10);
        if (rawClientId === '' || Number.isNaN(clientId)) {
            this.showToast('Please select a client', 'error');
            return;
        }

        try {
            const response = await fetch(`/update_task/${taskId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    start_time: startTime,
                    end_time: endTime,
                    client_id: clientId
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Task times overlap with existing tasks');
            }

            this.showToast('Task updated successfully');
            await this.fetchTasks();
            this.disableEditMode(row);
        } catch (error) {
            this.showToast(error.message, 'error');
            // Keep edit mode active so user can fix the error
        }
    }

    escapeHtml(str) {
        if (str == null || str === '') return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    escapeHtmlAttr(str) {
        if (str == null || str === '') return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    async copyToClipboard(text) {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            this.showToast('Copied to clipboard', 'success');
        } catch {
            this.showToast('Failed to copy', 'error');
        }
    }

    getClientOptions(selectedClientId) {
        const parts = [];
        if (selectedClientId == null) {
            parts.push('<option value="" selected disabled>REMOVED</option>');
        }
        parts.push(
            ...this.clients.map(client => `
            <option value="${client.id}" ${client.id === selectedClientId ? 'selected' : ''}>
                ${client.name}
            </option>
        `)
        );
        return parts.join('');
    }

    async fetchInitialData() {
        await this.fetchTasks();
        await this.checkDayStatus();
    }

    /** Replace the task table with a message plus a way to try again. */
    showTasksMessage(html) {
        const tbody = document.getElementById('tasks-tbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="5">${html}</td></tr>`;
    }

    async fetchDayData() {
        try {
            const response = await this.fetchFromAPI('/get_day_data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: this.selectedDate.value })
            });
            const { start_time, end_time } = response;

            // If no start time, we can't calculate day duration
            if (!start_time) {
                return 0;
            }

            // If end time is missing, use current time for today, or end of day for past dates
            let effectiveEndTime;
            if (!end_time) {
                const today = this.getLocalDateString();
                if (this.selectedDate.value === today) {
                    // For today, use current time
                    const now = new Date();
                    effectiveEndTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
                } else {
                    // For past dates without end time, assume end of day
                    effectiveEndTime = "23:59:59";
                }
            } else {
                effectiveEndTime = end_time;
            }

            // Calculate total day duration
            const totalDayMinutes = this.timeStringToMinutes(effectiveEndTime) - this.timeStringToMinutes(start_time);

            // Fetch and subtract break time
            const breakMinutes = await this.fetchBreakDuration();
            
            // Return day duration minus break time
            return Math.max(0, totalDayMinutes - breakMinutes);
        } catch (error) {
            this.showToast('Error fetching day data', 'error');
            return 0;
        }
    }

    async fetchBreakDuration() {
        try {
            const response = await this.fetchFromAPI('/get_breaks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: this.selectedDate.value })
            });

            // Sum up all completed breaks for the day
            let totalBreakMinutes = 0;
            for (const breakItem of response) {
                if (breakItem.start_time && breakItem.end_time) {
                    const breakDuration = this.timeStringToMinutes(breakItem.end_time) - 
                                        this.timeStringToMinutes(breakItem.start_time);
                    totalBreakMinutes += breakDuration;
                }
            }

            return totalBreakMinutes;
        } catch (error) {
            console.error('Error fetching break duration:', error);
            return 0;
        }
    }

    fetchTasks() {
        // Previously a concurrent call was dropped on the floor, so a date
        // change or the 60s refresh landing mid-load was simply lost. Share the
        // in-flight promise instead so every caller settles.
        if (this.loadPromise) return this.loadPromise;

        this.isLoading = true;
        this.loadPromise = this.#loadTasks().finally(() => {
            this.isLoading = false;
            this.loadPromise = null;
        });

        return this.loadPromise;
    }

    async #loadTasks() {
        const date = this.selectedDate.value;

        this.showTasksMessage('<div class="tk-loading"><span class="tk-spinner"></span> Loading tasks…</div>');

        try {
            // Always fetch and populate day data first
            await this.populateDayTimes();

            const response = await this.fetchFromAPI(`/tasks/${date}`);
            await this.renderTasks(response);
            this.renderTimeline(response, date);

            // Recovered — drop any queued retry.
            clearTimeout(this.reloadTimer);
        } catch (error) {
            console.error('Error fetching tasks:', error);

            // Say what's happening rather than leaving a bare spinner, then keep
            // trying on our own. The backend is local, so there's no reason to
            // make the user click anything — it'll come back when it comes back.
            this.showTasksMessage(
                '<div class="tk-empty"><span class="tk-spinner"></span>'
                + '<span class="ml-2">Can\'t reach the server. Reconnecting…</span></div>'
            );

            const timeline = document.getElementById('timeline');
            if (timeline) timeline.innerHTML = '';

            this.scheduleReload();
        }
    }

    /** Keep retrying a failed load in the background, indefinitely. */
    scheduleReload(delay = 3000) {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.fetchTasks(), delay);
    }

    async populateDayTimes() {
        try {
            const response = await this.fetchFromAPI('/get_day_data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: this.selectedDate.value })
            });
            const { start_time, end_time } = response;

            // Update the day time pickers with fetched data
            if (start_time) {
                const formattedStartTime = this.convertTo12HourFormat(start_time);
                this.dayStartTime.value = formattedStartTime;
                this.originalStartTime = formattedStartTime;
                
                // Set the flatpickr default date to the existing time
                this.dayStartTimePicker.setDate(formattedStartTime, false);
            } else {
                this.dayStartTime.value = '';
                this.originalStartTime = '';
                this.dayStartTimePicker.clear();
            }

            if (end_time) {
                const formattedEndTime = this.convertTo12HourFormat(end_time);
                this.dayEndTime.value = formattedEndTime;
                this.originalEndTime = formattedEndTime;
                
                // Set the flatpickr default date to the existing time
                this.dayEndTimePicker.setDate(formattedEndTime, false);
            } else {
                this.dayEndTime.value = '';
                this.originalEndTime = '';
                
                // For open days (has start_time but no end_time), set picker default to current time
                const today = this.getLocalDateString();
                const isToday = this.selectedDate.value === today;
                
                if (start_time && isToday) {
                    // Day is open and it's today - set picker default to current time but keep input empty
                    const now = new Date();
                    this.dayEndTimePicker.set('defaultHour', now.getHours());
                    this.dayEndTimePicker.set('defaultMinute', now.getMinutes());
                    this.dayEndTimePicker.clear();
                } else {
                    this.dayEndTimePicker.clear();
                }
            }

            // Hide action buttons when loading fresh data
            this.hideTimeActions('start');
            this.hideTimeActions('end');

            // Check if we should show the Close Day button
            await this.updateCloseDayButtonVisibility();
        } catch (error) {
            console.error('Error populating day times:', error);
            this.dayStartTime.value = '';
            this.dayEndTime.value = '';
            this.originalStartTime = '';
            this.originalEndTime = '';
            this.closeDayContainer.classList.add('hidden');
        }
    }

    async updateCloseDayButtonVisibility() {
        try {
            // Check if the selected date is today
            const today = this.getLocalDateString();
            const isToday = this.selectedDate.value === today;

            if (!isToday) {
                this.closeDayContainer.classList.add('hidden');
                return;
            }

            // Check day status
            const status = await this.fetchFromAPI('/check_day_status');
            const { dayStarted, dayEnded } = status;

            // Show button only if day is started but not ended
            if (dayStarted && !dayEnded) {
                this.closeDayContainer.classList.remove('hidden');
            } else {
                this.closeDayContainer.classList.add('hidden');
            }
        } catch (error) {
            console.error('Error checking day status:', error);
            this.closeDayContainer.classList.add('hidden');
        }
    }

    async updateSummaryValues(totalMinutesForAll, totalFractionalHours) {
        // Fetch total working time (day_end - day_start - breaks)
        const overallDayTime = await this.fetchDayData() || 0;

        // Calculate non-billable time (working time minus billable task time)
        // Non-billable = time at work but not tracked to any client task
        let nonBillableTimeMins = Math.max(0, overallDayTime - totalMinutesForAll);
        const nonBillableHours = this.totalTimeSpentToFractionalHours(nonBillableTimeMins);

        const totalTimeFractionalHours = totalFractionalHours + nonBillableHours;
        const totalTimeLoggedDayMins = overallDayTime;

        // Calculate differences and arrows
        const billDifference = Math.round(totalFractionalHours * 60 - totalMinutesForAll);
        const nonDifference = Math.round(nonBillableHours * 60 - nonBillableTimeMins);
        const allDayDifference = Math.round(totalTimeFractionalHours * 60 - totalTimeLoggedDayMins);

        // Update display values with differences
        document.getElementById('billable-value').innerHTML = this.formatTimeWithDifference(
            totalFractionalHours,
            totalMinutesForAll,
            billDifference
        );

        document.getElementById('nonbillable-value').innerHTML = this.formatTimeWithDifference(
            nonBillableHours,
            nonBillableTimeMins,
            nonDifference
        );

        document.getElementById('total-time-value').innerHTML = this.formatTimeWithDifference(
            totalTimeFractionalHours,
            totalTimeLoggedDayMins,
            allDayDifference
        );
    }

    formatTimeWithDifference(fractionalHours, totalMinutes, difference) {
        const colorClass = difference > 0 ? 'text-success' : 'text-danger';
        const diffDisplay = difference !== 0
            ? `<span class="${colorClass} ml-1 text-xs font-medium">${difference > 0 ? '+' : '−'}${Math.abs(difference)}m</span>`
            : '';

        return `${fractionalHours}<span class="text-faint font-normal"> hrs</span>`
            + `<span class="text-faint font-normal text-xs"> · ${this.minutesToHoursMinutes(totalMinutes)}</span>`
            + diffDisplay;
    }

    async renderTasks(tasks) {
        const tbody = document.getElementById('tasks-tbody');

        // First fetch all clients for the dropdown. This used to be a bare
        // .then() with no .catch(): a failure here cleared the table and then
        // rejected into nothing, leaving a permanently blank page.
        const clients = await this.fetchFromAPI('/clients');
        tbody.innerHTML = '';

        this.clients = clients;

        const clientGroups = this.aggregateByClient(tasks);
        let totalMinutesForAll = 0;
        let totalFractionalHours = 0;

        if (clientGroups.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="tk-empty">No time tracked on this date.</td>
                </tr>
            `;
            // Still update summary values even with no tasks
            this.updateSummaryValues(0, 0);
            return;
        }

        clientGroups.forEach(client => {
            const totalMinutes = this.totalNumberofMinutesPerClient(client.tasks);
            totalMinutesForAll += totalMinutes;
            const fractionalHours = this.totalTimeSpentToFractionalHours(totalMinutes);
            totalFractionalHours += fractionalHours;

            // Add the summary row
            const summaryRow = document.createElement('tr');
            summaryRow.className = 'task-row';
            const roundingDiff = Math.round(fractionalHours * 60 - totalMinutes);
            summaryRow.innerHTML = `
                <td class="font-medium">
                    <span class="inline-flex items-center gap-2">
                        <svg class="tk-chevron h-3.5 w-3.5 flex-shrink-0 text-faint transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                        ${this.escapeHtml(client.name)}
                    </span>
                </td>
                <td>
                    ${client.id == null
                ? '<span class="text-faint">—</span>'
                : `<div class="tk-inline-actions">
                            <button type="button" class="works-open-btn tk-btn tk-btn-secondary tk-btn-sm">Works</button>
                            <button type="button" class="works-copy-btn tk-btn tk-btn-secondary tk-btn-sm">Copy</button>
                        </div>`}
                </td>
                <td class="tk-num text-muted">${this.minutesToHoursMinutes(totalMinutes)}</td>
                <td class="tk-num font-semibold">${fractionalHours}</td>
                <td class="tk-num ${roundingDiff === 0 ? 'text-faint' : roundingDiff > 0 ? 'text-success' : 'text-danger'}">
                    ${roundingDiff === 0 ? '—' : (roundingDiff > 0 ? '+' : '−') + Math.abs(roundingDiff) + 'm'}
                </td>
            `;
            summaryRow.addEventListener('click', (e) => {
                // The works buttons sit inside the row, which is itself the
                // fold/unfold target — so they have to swallow their own clicks.
                if (e.target.closest('.works-open-btn')) {
                    e.stopPropagation();
                    this.openWorksModal(client);
                    return;
                }
                if (e.target.closest('.works-copy-btn')) {
                    e.stopPropagation();
                    this.copyWorks(client);
                    return;
                }
                this.toggleDetailTable(client.detailKey);
            });
            tbody.appendChild(summaryRow);

            // Add the detail row
            const detailRow = this.createDetailRow(client);
            tbody.appendChild(detailRow);
        });

        this.updateSummaryValues(totalMinutesForAll, totalFractionalHours);
    }

    aggregateByClient(tasks) {
        const clientMap = {};
        tasks.forEach((task) => {
            const detailKey = task.client_id == null ? '__removed__' : String(task.client_id);
            if (!clientMap[detailKey]) {
                clientMap[detailKey] = {
                    id: task.client_id,
                    detailKey,
                    name: task.client_name,
                    totalTimeSpent: 0,
                    tasks: [],
                };
            }
            clientMap[detailKey].totalTimeSpent += task.time_spent;
            clientMap[detailKey].tasks.push(task);
        });
        return Object.values(clientMap);
    }

    createDetailRow(client) {
        const detailRow = document.createElement('tr');
        detailRow.id = `detail-row-${client.detailKey}`;
        detailRow.className = 'detail-row hidden';

        const detailCell = document.createElement('td');
        detailCell.colSpan = 5;
        detailCell.className = 'p-0';

        const detailTable = document.createElement('table');
        detailTable.className = 'tk-table tk-table-nested tk-table-hover';
        detailTable.innerHTML = `
            <thead>
                <tr>
                    <th>Start</th>
                    <th>End</th>
                    <th class="tk-num">Duration</th>
                    <th class="w-px">Actions</th>
                </tr>
            </thead>
            <tbody>
                ${client.tasks.map(task => `
                    <tr data-task-id="${task.id}" class="${task.is_ongoing ? 'tk-row-ongoing' : ''}">
                        <td class="tk-num whitespace-nowrap">
                            <span class="time-display">${this.convertTo12HourFormat(task.start_time)}</span>
                            <input type="text" class="task-time-picker start-time tk-time-input hidden" value="${task.start_time}">
                        </td>
                        <td class="tk-num whitespace-nowrap">
                            <span class="time-display">
                                ${task.is_ongoing ?
                `${this.convertTo12HourFormat(task.end_time)} <span class="tk-badge tk-badge-warn ml-1.5">Ongoing</span>` :
                this.convertTo12HourFormat(task.end_time)}
                            </span>
                            <input type="text" class="task-time-picker end-time tk-time-input hidden" value="${task.end_time || ''}">
                        </td>
                        <td class="tk-num whitespace-nowrap text-muted">${this.getMinuteDifference(task.end_time, task.start_time)}m</td>
                        <td>
                            <div class="flex gap-1.5">
                                <button class="edit-task-btn tk-btn tk-btn-secondary tk-btn-sm">Edit</button>
                                <button class="delete-task-btn tk-btn tk-btn-danger tk-btn-sm">Delete</button>
                            </div>
                            <div class="edit-controls hidden mt-2 space-y-2">
                                <select class="client-select tk-select text-sm">
                                    ${this.getClientOptions(task.client_id)}
                                </select>
                                <div class="flex gap-1.5">
                                    <button class="save-task-btn tk-btn tk-btn-primary tk-btn-sm">Save</button>
                                    <button class="cancel-task-btn tk-btn tk-btn-secondary tk-btn-sm">Cancel</button>
                                </div>
                            </div>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        `;

        detailCell.appendChild(detailTable);
        detailRow.appendChild(detailCell);

        setTimeout(() => {
            detailRow.querySelectorAll('.task-time-picker').forEach(input => {
                flatpickr(input, {
                    enableTime: true,
                    noCalendar: true,
                    dateFormat: "h:i K", // Changed from "H:i" to "h:i K" for 12-hour format with AM/PM
                    time_24hr: false,    // Changed from true to false
                    minuteIncrement: 1
                });
            });

        }, 0);

        return detailRow;
    }

    toggleDetailTable(clientId) {
        const detailRow = document.getElementById(`detail-row-${clientId}`);
        const expanded = detailRow.classList.toggle('hidden') === false;

        // The summary row immediately precedes its detail row.
        const chevron = detailRow.previousElementSibling?.querySelector('.tk-chevron');
        if (chevron) chevron.style.transform = expanded ? 'rotate(90deg)' : '';
    }

    convertTo12HourFormat(timeString) {
        if (!timeString) return '-';
        const [hours, minutes] = timeString.split(':');
        const period = +hours >= 12 ? 'PM' : 'AM';
        const hour = +hours % 12 || 12;
        return `${hour}:${minutes} ${period}`;
    }

    getLocalDateString() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    getMinuteDifference(endTime, startTime) {
        if (!endTime) return 0;
        return this.timeStringToMinutes(endTime) - this.timeStringToMinutes(startTime);
    }

    totalNumberofMinutesPerClient(tasks) {
        return tasks.reduce((total, task) => {
            const startDate = new Date(`1970-01-01T${task.start_time}Z`);
            const endDate = task.end_time ?
                new Date(`1970-01-01T${task.end_time}Z`) :
                new Date();
            return total + Math.floor(Math.abs(endDate - startDate) / (1000 * 60));
        }, 0);
    }

    initializeTimePicker() {
        this.timePicker = flatpickr(this.selectedDate, {
            enableTime: false,
            dateFormat: "Y-m-d",
            defaultDate: new Date(),
            onChange: () => this.fetchTasks()
        });
    }

    async checkDayStatus() {
        const { dayStarted, unfinishedTasksExist, dayEnded, breakTimeStarted } =
            await this.fetchFromAPI('/check_day_status');

        if (dayStarted && !dayEnded && !breakTimeStarted) {
            this.handleOpenDayState(unfinishedTasksExist);
        } else if (!dayStarted && !dayEnded) {
            this.handleNotStartedState();
        } else if (dayEnded) {
            this.handleEndedDayState();
        } else if (breakTimeStarted) {
            this.handleBreakState();
        }
    }

    handleOpenDayState(unfinishedTasksExist) {
        // Update UI state for open day
    }

    handleNotStartedState() {
        // Update UI state for not started day
    }

    handleEndedDayState() {
        // Update UI state for ended day
    }

    handleBreakState() {
        // Update UI state for break time
    }


    renderTimeline(tasks, selectedDate) {
        const container = document.getElementById('timeline');
        container.innerHTML = `
        <div class="tk-loading h-[200px]"><span class="tk-spinner"></span> Loading timeline…</div>
    `;

        // Colour comes from clientColor() in base.js, keyed on the client's
        // name, so a client is the same colour here and on the Summary charts.
        // This used to be a hardcoded stock-palette array indexed by position,
        // which meant the colours disagreed between the two pages and ignored
        // the theme entirely.
        //
        // Only background-color is set inline: border-radius and padding are
        // owned by .vis-item / .vis-item-content in app.css, and setting them
        // here either lost to an !important or double-padded the content.
        const items = tasks.map(task => ({
            id: task.id,
            content: task.client_name,
            start: `${selectedDate}T${task.start_time}`,
            end: task.end_time ? `${selectedDate}T${task.end_time}` : undefined,
            style: `background-color: ${clientColor(task.client_name)};`
        }));

        // Calculate a view centered on the current time
        const now = new Date();
        const today = this.getLocalDateString();
        const isSelectedDateToday = selectedDate === today;

        // Set the view duration (how many hours to show)
        const viewDuration = 8; // Show 8 hours

        let centerHour;
        if (isSelectedDateToday) {
            // If viewing today, center on current hour
            centerHour = now.getHours();
        } else {
            // If viewing another day, center on midday (12 PM)
            centerHour = 12;
        }

        // Calculate start and end times to center the view on the current hour
        const startHour = Math.max(0, centerHour - Math.floor(viewDuration / 2));
        const endHour = Math.min(23, startHour + viewDuration);

        const startTime = `${selectedDate}T${String(startHour).padStart(2, '0')}:00:00`;
        const endTime = `${selectedDate}T${String(endHour).padStart(2, '0')}:00:00`;

        const options = {
            start: startTime,
            end: endTime,
            timeAxis: { scale: 'hour', step: 1 },
            orientation: 'top',
            stack: false,
            verticalScroll: true,
            zoomKey: 'ctrlKey',
            height: '200px',
            min: `${selectedDate}T00:00:00`,
            max: `${selectedDate}T23:59:59`,
            format: {
                minorLabels: {
                    millisecond: 'SSS',
                    second: 's',
                    minute: 'h:mm A', // AM/PM format
                    hour: 'h A',      // AM/PM format
                    weekday: 'ddd D',
                    day: 'D',
                    week: 'w',
                    month: 'MMM',
                    year: 'YYYY'
                },
                majorLabels: {
                    millisecond: 'h:mm:ss A', // AM/PM format
                    second: 'D MMMM h:mm A',  // AM/PM format
                    minute: 'ddd D MMMM',
                    hour: 'ddd D MMMM',
                    weekday: 'MMMM YYYY',
                    day: 'MMMM YYYY',
                    week: 'MMMM YYYY',
                    month: 'YYYY',
                    year: ''
                }
            },
        };

        container.innerHTML = '';

        const timeline = new vis.Timeline(
            container,
            new vis.DataSet(items),
            options
        );

        return timeline;
    }



}

ready(() => {
    new TaskBrowser();
});