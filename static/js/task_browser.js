import { TimeKeeper } from './base.js';

export class TaskBrowser extends TimeKeeper {
    constructor() {
        super();
        this.isLoading = false;
        this.initializeElements();
        this.initializeTimePicker();
        this.initializeDayTimePickers();
        this.fetchInitialData();
        this.initializeTaskEditing();

        setInterval(() => {
            if (this.selectedDate.value === new Date().toISOString().split('T')[0]) {
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

        // Bind action buttons
        this.closeDayBtn.addEventListener('click', () => this.handleCloseDay());
        this.saveStartBtn.addEventListener('click', () => this.handleSaveTime('start'));
        this.cancelStartBtn.addEventListener('click', () => this.handleCancelTime('start'));
        this.saveEndBtn.addEventListener('click', () => this.handleSaveTime('end'));
        this.cancelEndBtn.addEventListener('click', () => this.handleCancelTime('end'));
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
        const clientId = parseInt(row.querySelector('.client-select').value);

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

    getClientOptions(selectedClientId) {
        return this.clients.map(client => `
            <option value="${client.id}" ${client.id === selectedClientId ? 'selected' : ''}>
                ${client.name}
            </option>
        `).join('');
    }

    async fetchInitialData() {
        await this.fetchTasks();
        await this.checkDayStatus();
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
                const today = new Date().toISOString().split('T')[0];
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

            return this.timeStringToMinutes(effectiveEndTime) - this.timeStringToMinutes(start_time);
        } catch (error) {
            this.showToast('Error fetching day data', 'error');
            return 0;
        }
    }

    async fetchTasks() {
        if (this.isLoading) return;

        this.isLoading = true;
        const timelineContainer = document.getElementById('timeline');
        const tbody = document.getElementById('tasks-tbody');

        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="px-6 py-8 text-center">
                    <div class="flex items-center justify-center">
                        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
                        <span class="ml-3 text-gray-600">Loading tasks...</span>
                    </div>
                </td>
            </tr>
        `;

        try {
            // Always fetch and populate day data first
            await this.populateDayTimes();
            
            const response = await this.fetchFromAPI(`/tasks/${this.selectedDate.value}`);
            this.renderTasks(response);
            this.renderTimeline(response, this.selectedDate.value);
        } catch (error) {
            this.showToast('Error fetching tasks', 'error');
        } finally {
            this.isLoading = false;
        }
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
                const today = new Date().toISOString().split('T')[0];
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
            const today = new Date().toISOString().split('T')[0];
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
        const overallDayTime = await this.fetchDayData() || 0;

        // Calculate non-billable time (total day time minus billable time)
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
        const arrow = difference > 0 ? '▲' : '▼';
        const colorClass = difference > 0 ? 'text-green-600' : 'text-red-600';
        const diffDisplay = difference !== 0
            ? `<span class="${colorClass}">${arrow}${Math.abs(difference)}</span>`
            : '';

        return `${fractionalHours} hrs. (${this.minutesToHoursMinutes(totalMinutes)}) ${diffDisplay}`;
    }

    renderTasks(tasks) {
        const tbody = document.getElementById('tasks-tbody');
        tbody.innerHTML = '';

        // First fetch all clients for the dropdown
        this.fetchFromAPI('/clients')
            .then(clients => {
                this.clients = clients;

                const clientGroups = this.aggregateByClient(tasks);
                let totalMinutesForAll = 0;
                let totalFractionalHours = 0;

                if (clientGroups.length === 0) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="4" class="px-6 py-8 text-center text-gray-500">
                                No tasks found for this date
                            </td>
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
                    summaryRow.className = 'task-row hover:bg-gray-50 cursor-pointer transition-colors';
                    summaryRow.innerHTML = `
                        <td class="px-6 py-4 font-medium">${client.name}</td>
                        <td class="px-6 py-4">${totalMinutes} minutes</td>
                        <td class="px-6 py-4 font-semibold">${fractionalHours} hrs.</td>
                        <td class="px-6 py-4 ${fractionalHours * 60 - totalMinutes > 0 ? 'text-green-600' : 'text-red-600'}">
                            ${fractionalHours * 60 - totalMinutes} minutes
                        </td>
                    `;
                    summaryRow.addEventListener('click', () => this.toggleDetailTable(client.id));
                    tbody.appendChild(summaryRow);

                    // Add the detail row
                    const detailRow = this.createDetailRow(client);
                    tbody.appendChild(detailRow);
                });

                this.updateSummaryValues(totalMinutesForAll, totalFractionalHours);
            });
    }

    aggregateByClient(tasks) {
        const clientMap = {};
        tasks.forEach((task) => {
            if (!clientMap[task.client_id]) {
                clientMap[task.client_id] = {
                    id: task.client_id,
                    name: task.client_name,
                    totalTimeSpent: 0,
                    tasks: [],
                };
            }
            clientMap[task.client_id].totalTimeSpent += task.time_spent;
            clientMap[task.client_id].tasks.push(task);
        });
        return Object.values(clientMap);
    }

    createDetailRow(client) {
        const detailRow = document.createElement('tr');
        detailRow.id = `detail-row-${client.id}`;
        detailRow.className = 'detail-row hidden';

        const detailCell = document.createElement('td');
        detailCell.colSpan = 4;
        detailCell.className = 'p-0';

        const detailTable = document.createElement('table');
        detailTable.className = 'w-full border-t border-gray-200';
        detailTable.innerHTML = `
            <thead>
                <tr class="bg-gray-100 text-xs uppercase tracking-wider text-gray-600">
                    <th class="px-4 py-3 text-left">Start Time</th>
                    <th class="px-4 py-3 text-left">End Time</th>
                    <th class="px-4 py-3 text-left">Description</th>
                    <th class="px-4 py-3 text-left">Time Spent</th>
                    <th class="px-4 py-3 text-left">Actions</th>
                </tr>
            </thead>
            <tbody>
                ${client.tasks.map(task => `
                    <tr data-task-id="${task.id}" class="${task.is_ongoing ? 'bg-yellow-50' : ''} hover:bg-gray-50">
                        <td class="px-4 py-3">
                            <span class="time-display">${this.convertTo12HourFormat(task.start_time)}</span>
                            <input type="text" class="task-time-picker start-time hidden w-24 p-1 border rounded" value="${task.start_time}">
                        </td>
                        <td class="px-4 py-3">
                            <span class="time-display">
                                ${task.is_ongoing ?
                `${this.convertTo12HourFormat(task.end_time)} <span class="text-yellow-600 text-xs font-medium ml-1">(Ongoing)</span>` :
                this.convertTo12HourFormat(task.end_time)}
                            </span>
                            <input type="text" class="task-time-picker end-time hidden w-24 p-1 border rounded" value="${task.end_time || ''}">
                        </td>
                        <td class="px-4 py-3 max-w-xs truncate">${task.description || '<span class="text-gray-400 italic">No description</span>'}</td>
                        <td class="px-4 py-3">${this.getMinuteDifference(task.end_time, task.start_time)} minutes</td>
                        <td class="px-4 py-3">
                            <div class="flex space-x-2">
                                <button class="edit-task-btn text-white px-3 py-1 rounded text-sm">Edit</button>
                                <button class="delete-task-btn text-white px-3 py-1 rounded text-sm">Delete</button>
                            </div>
                            <div class="edit-controls hidden mt-2 space-y-2">
                                <select class="client-select w-full p-1 border rounded text-sm">
                                    ${this.getClientOptions(task.client_id)}
                                </select>
                                <div class="flex space-x-2">
                                    <button class="save-task-btn text-white px-3 py-1 rounded text-sm">Save</button>
                                    <button class="cancel-task-btn text-white px-3 py-1 rounded text-sm">Cancel</button>
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
        detailRow.classList.toggle('hidden');
    }

    convertTo12HourFormat(timeString) {
        if (!timeString) return '-';
        const [hours, minutes] = timeString.split(':');
        const period = +hours >= 12 ? 'PM' : 'AM';
        const hour = +hours % 12 || 12;
        return `${hour}:${minutes} ${period}`;
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
        <div class="flex items-center justify-center h-[200px]">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            <span class="ml-2 text-gray-600">Loading timeline...</span>
        </div>
    `;

        // Create a color map for clients
        const clientColors = {};
        const colors = [
            '#3b82f6', // Blue
            '#10b981', // Green
            '#ef4444', // Red
            '#8b5cf6', // Purple
            '#f59e0b', // Orange
            '#06b6d4', // Cyan
            '#6b7280', // Gray
            '#0ea5e9', // Sky
            '#8b5cf6', // Violet
            '#f43f5e'  // Pink
        ];

        // Assign colors to unique clients
        const uniqueClients = [...new Set(tasks.map(task => task.client_id))];
        uniqueClients.forEach((clientId, index) => {
            clientColors[clientId] = colors[index % colors.length];
        });

        // Create data sets for timeline with client colors
        const items = tasks.map(task => ({
            id: task.id,
            content: task.client_name,
            start: `${selectedDate}T${task.start_time}`,
            end: task.end_time ? `${selectedDate}T${task.end_time}` : undefined,
            style: `background-color: ${clientColors[task.client_id]}; color: white; border-radius: 4px; padding: 2px 8px;`
        }));

        // Calculate a view centered on the current time
        const now = new Date();
        const today = new Date().toISOString().split('T')[0];
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

document.addEventListener('DOMContentLoaded', () => {
    const taskBrowser = new TaskBrowser();
});