import { TimeKeeper } from './base.js';

export class TaskBrowser extends TimeKeeper {
    constructor() {
        super();
        this.initializeElements();
        this.initializeTimePicker();
        this.fetchInitialData();
    }

    initializeElements() {
        this.selectedDate = document.getElementById('selected-date');
        this.datePicker = flatpickr(this.selectedDate, {
            defaultDate: new Date(),
            dateFormat: "Y-m-d",
            onChange: () => this.fetchTasks()
        });
    }

    async fetchInitialData() {
        await this.fetchTasks();
        await this.fetchBreaks();
        await this.checkDayStatus();
    }

    async fetchBreaks() {
        try {
            const response = await this.fetchFromAPI('/get_breaks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: this.selectedDate.value })
            });
            this.renderBreaks(response);
            return response;
        } catch (error) {
            this.showToast('Error fetching breaks', 'red');
        }
    }

    async fetchDayData() {
        try {
            const response = await this.fetchFromAPI('/get_day_data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: this.selectedDate.value })
            });
            const { start_time, end_time } = response;
            return this.timeStringToMinutes(end_time) - this.timeStringToMinutes(start_time);
        } catch (error) {
            this.showToast('Error fetching day data', 'red');
        }
    }

    async fetchTasks() {
        try {
            const response = await this.fetchFromAPI(`/tasks/${this.selectedDate.value}`);
            this.renderTasks(response);
            this.renderTimeline(response, this.selectedDate.value);
        } catch (error) {
            this.showToast('Error fetching tasks', 'red');
        }
    }



    renderBreaks(breaks) {
        const breaksContainer = document.getElementById('break-value');
        const totalTime = breaks.length ? this.totalNumberofMinutesPerClient(breaks) : 0;
        breaksContainer.innerHTML = `${this.totalTimeSpentToFractionalHours(totalTime)} hrs. (${this.minutesToHoursMinutes(totalTime)})`;
        breaksContainer.setAttribute('totalBreakMins', totalTime);
    }

    async updateSummaryValues(totalMinutesForAll, totalFractionalHours) {
        const overallDayTime = await this.fetchDayData();
        const totalBreakTime = parseInt(document.getElementById('break-value').getAttribute('totalBreakMins')) || 0;

        const nonBillableTimeMins = overallDayTime - totalBreakTime - totalMinutesForAll;
        const nonBillableHours = this.totalTimeSpentToFractionalHours(nonBillableTimeMins);

        const totalTimeFractionalHours = totalFractionalHours + nonBillableHours;
        const totalTimeLoggedDayMins = overallDayTime - totalBreakTime;

        // Calculate differences and arrows
        const billDifference = totalFractionalHours * 60 - totalMinutesForAll;
        const nonDifference = nonBillableHours * 60 - nonBillableTimeMins;
        const allDayDifference = totalTimeFractionalHours * 60 - totalTimeLoggedDayMins;

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

        const clients = this.aggregateByClient(tasks);
        let totalMinutesForAll = 0;
        let totalFractionalHours = 0;

        clients.forEach((client) => {
            const totalMinutes = this.totalNumberofMinutesPerClient(client.tasks);
            totalMinutesForAll += totalMinutes;
            const fractionalHours = this.totalTimeSpentToFractionalHours(totalMinutes);
            totalFractionalHours += fractionalHours;
            const difference = fractionalHours * 60 - totalMinutes;

            const aggregateRow = document.createElement('tr');
            aggregateRow.className = 'hover:bg-gray-50 cursor-pointer';
            aggregateRow.innerHTML = `
                <td class="p-3 border">${client.name}</td>
                <td class="p-3 border">${totalMinutes} minutes</td>
                <td class="p-3 border">${fractionalHours} hrs.</td>
                <td class="p-3 border ${difference < 0 ? 'text-red-600' : 'text-green-600'}">${difference} minutes</td>
            `;

            aggregateRow.addEventListener('click', () => this.toggleDetailTable(client.id));
            tbody.appendChild(aggregateRow);

            const detailRow = this.createDetailRow(client);
            tbody.appendChild(detailRow);
        });

        this.updateSummaryValues(totalMinutesForAll, totalFractionalHours);
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
        detailRow.className = 'hidden bg-gray-50';

        const detailCell = document.createElement('td');
        detailCell.colSpan = 4;
        detailCell.className = 'p-3';

        const detailTable = document.createElement('table');
        detailTable.className = 'w-full border-collapse';
        detailTable.innerHTML = `
            <thead>
                <tr>
                    <th class="p-2 text-left border">Start Time</th>
                    <th class="p-2 text-left border">End Time</th>
                    <th class="p-2 text-left border">Description</th>
                    <th class="p-2 text-left border">Time Spent</th>
                </tr>
            </thead>
            <tbody>
                ${client.tasks.map(task => `
                    <tr>
                        <td class="p-2 border">${this.convertTo12HourFormat(task.start_time)}</td>
                        <td class="p-2 border">${task.end_time ? this.convertTo12HourFormat(task.end_time) : ''}</td>
                        <td class="p-2 border">${task.description || ''}</td>
                        <td class="p-2 border">${this.getMinuteDifference(task.end_time, task.start_time)} minutes</td>
                    </tr>
                `).join('')}
            </tbody>
        `;

        detailCell.appendChild(detailTable);
        detailRow.appendChild(detailCell);
        return detailRow;
    }

    toggleDetailTable(clientId) {
        const detailRow = document.getElementById(`detail-row-${clientId}`);
        detailRow.classList.toggle('hidden');
    }

    convertTo12HourFormat(timeString) {
        const [hours, minutes] = timeString.split(':');
        const period = +hours >= 12 ? 'PM' : 'AM';
        const hour = +hours % 12 || 12;
        return `${String(hour).padStart(2)}:${minutes} ${period}`;
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
            enableTime: true,
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
        container.innerHTML = '';

        // Create a color map for clients
        const clientColors = {};
        const colors = [
            '#2196F3', // Blue
            '#4CAF50', // Green
            '#F44336', // Red
            '#9C27B0', // Purple
            '#FF9800', // Orange
            '#00BCD4', // Cyan
            '#795548', // Brown
            '#009688', // Teal
            '#673AB7', // Deep Purple
            '#FF5722'  // Deep Orange
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
            style: `background-color: ${clientColors[task.client_id]}; color: white;`
        }));

        const options = {
            start: `${selectedDate}T00:00:00`,
            end: `${selectedDate}T23:59:59`,
            timeAxis: { scale: 'minute', step: 30 },
            orientation: 'top',
            stack: false,
            verticalScroll: true,
            zoomKey: 'ctrlKey',
            height: '200px',
            min: `${selectedDate}T00:00:00`,
            max: `${selectedDate}T23:59:59`
        };

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
