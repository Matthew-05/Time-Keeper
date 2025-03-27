import { TimeKeeper } from './base.js';

export class TimeKeeperIndex extends TimeKeeper {
    constructor() {
        super();
        this.initializeElements();
        this.initializeTimePicker();
        this.bindEvents();
    }

    async init() {
        // First check day status
        await this.checkDayStatus();

        // Only check for unfinished tasks if day has started
        const { dayStarted } = await this.fetchFromAPI('/check_day_status');
        if (dayStarted) {
            await this.initializeAutocomplete();
            await this.checkUnfinishedTasks();
        } else {
            // Still initialize autocomplete for when day starts
            await this.initializeAutocomplete();
        }

        console.log("Timekeeper.js loaded");
    }




    initializeElements() {
        this.clientInput = document.getElementById('autocomplete-input');
        this.typeInput = document.getElementById('type-input');
        this.descriptionInput = document.getElementById('description-input');
        this.actionButton = document.getElementById('action-button');
        this.completeButton = document.getElementById('complete-button');
        this.startButton = document.getElementById('start-button');
        this.startBreakButton = document.getElementById('start-break-button');
        this.endBreakButton = document.getElementById('end-break-button');
        this.startDayButton = document.getElementById('start-day-button');
        this.endDayButton = document.getElementById('end-day-button');
        this.reopenDayButton = document.getElementById('reopen-day-button');
        this.timePicker = document.getElementById('timepicker');
    }

    initializeTimePicker() {
        this.timePickerInstance = flatpickr(this.timePicker, {
            enableTime: true,
            noCalendar: true,
            dateFormat: "h:i K",
            defaultDate: new Date(),
            onChange: (selectedDates) => {
                this.handleTimePickerClose();
                this.validateSelectedTime();
            }
        });
    }


    bindEvents() {
        this.startDayButton.addEventListener('click', () => this.handleStartDay());
        this.endDayButton.addEventListener('click', () => this.handleEndDay());
        this.startButton.addEventListener('click', () => this.startTask());
        this.completeButton.addEventListener('click', () => this.completeTask());
        this.startBreakButton.addEventListener('click', () => this.startBreak());
        this.endBreakButton.addEventListener('click', () => this.endBreak());
        this.reopenDayButton.addEventListener('click', () => this.reopenDay());
    }

    async getMostRecentEndTimeFromBackend() {
        const response = await this.fetchFromAPI('/most_recent_end_time');
        if (response.mostRecentEndTime) {
            const dateObj = new Date(`2000-01-01 ${response.mostRecentEndTime}`);
            const hours = dateObj.getHours();
            const minutes = dateObj.getMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const formattedHours = hours % 12 || 12;
            const formattedMinutes = minutes.toString().padStart(2, '0');
            const timeString = `${formattedHours}:${formattedMinutes} ${ampm}`;

            document.getElementById('lowestTimeAllowed').innerHTML = `Min. time: ${timeString}`;
            return response.mostRecentEndTime;
        }
        return null;
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

    async checkUnfinishedTasks() {
        const tasks = await this.fetchFromAPI('/unfinished_tasks');
        if (tasks.length > 0) {
            // First set up the initial value in Choices.js
            this.autocomplete.setChoiceByValue(tasks[0].client);

            this.showTaskCompletionForm(tasks[0]);
            this.completeButton.dataset.taskId = tasks[0].id;
        } else {
            this.showStartTaskForm();
        }
    }


    async handleStartDay() {
        try {
            const response = await this.fetchFromAPI('/start_day', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time: this.timePicker.value })
            });

            // If we get here, the request was successful (fetchFromAPI would throw on error)
            this.showToast('Day started successfully', 'success');

            // Update the UI
            await this.checkDayStatus();

            // Show client selection after day started
            this.showStartTaskForm();

            // Initialize client selection if not already done
            if (!this.autocomplete) {
                await this.initializeAutocomplete();
            }

            // Update buttons to show start task option
            this.updateButtonVisibility('dayStarted');
        } catch (error) {
            console.error('Failed to start day:', error);
            // Error is already handled by fetchFromAPI with a toast
        }
    }





    async startTask() {
        const clientName = this.clientInput.value;
        const selectedTime = this.timePicker.value;

        if (!clientName) {
            this.showToast('Please select a client.', 'yellow');
            return;
        }

        const now = new Date();
        const currentTime = this.getCurrentTimeIn12HourFormat();

        if (selectedTime !== currentTime) {
            if (!confirm(`Selected time (${selectedTime}) differs from current time (${currentTime}). Continue with selected time?`)) {
                return;
            }
        }

        const response = await this.fetchFromAPI('/add_unfinished_task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client: clientName,
                startTime: selectedTime
            })
        });

        if (response.success) {
            this.clearInputs();
            await this.checkDayStatus();
            await this.checkUnfinishedTasks();
        }
    }


    clearInputs() {
        this.clientInput.value = '';
        this.typeInput.value = '';
        this.descriptionInput.value = '';
    }



    async completeTask() {
        const response = await this.fetchFromAPI('/complete_task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client: this.clientInput.value,
                type: this.typeInput.value,
                description: this.descriptionInput.value,
                endTime: this.timePicker.value
            })
        });

        if (response.success) {
            this.showToast(`Task completed successfully for client: ${this.clientInput.value}`, 'green');
            this.clearInputs();
            this.autocomplete.setChoiceByValue('');
            this.completeButton.style.display = 'none';
            this.startButton.style.display = 'block';
            await this.checkDayStatus();
            await this.checkUnfinishedTasks();
        }
    }





    initializeAutocomplete() {
        // Remove any existing event listeners first
        if (this.autocomplete) {
            this.autocomplete.passedElement.element.removeEventListener('addItem', this.handleClientChange);
            this.autocomplete.destroy();
        }

        // Create the handler as a class property so we can reference it for removal
        this.handleClientChange = (event) => {
            const selectedValue = event.detail.value;
            if (selectedValue) {
                this.updateTaskClient(selectedValue);
            }
        };

        this.autocomplete = new Choices(this.clientInput, {
            searchPlaceholderValue: 'Start typing client name...',
            placeholder: true,
            placeholderValue: 'Select a client',
            searchResultLimit: 10,
            classNames: {
                containerOuter: 'choices',
                containerInner: 'choices__inner',
                input: 'choices__input',
                inputCloned: 'choices__input--cloned',
                list: 'choices__list',
                listItems: 'choices__list--items',
                listSingle: 'choices__list--single',
                listDropdown: 'choices__list--dropdown'
            }
        });







        // Add the single event listener
        this.autocomplete.passedElement.element.addEventListener('addItem', this.handleClientChange);

        this.loadChoices();
    }







    async updateTaskClient(newClientName) {
        // First check if there's an active task
        const tasks = await this.fetchFromAPI('/unfinished_tasks');
        if (tasks.length === 0) {
            return; // Exit early if no task is running
        }

        const response = await this.fetchFromAPI('/update_task_client', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client: newClientName
            })
        });

        if (response.success) {
            this.showToast(`Client updated to: ${newClientName}`, 'green');
        }
    }






    async loadChoices() {
        try {
            const data = await this.fetchFromAPI('/autocomplete');
            this.autocomplete.setChoices(
                data.map(item => ({
                    value: item,
                    label: item
                })),
                'value',
                'label',
                false
            );
        } catch (error) {
            console.error('Failed to load choices:', error);
        }
    }


    validateTaskInput() {
        if (!this.clientInput.value) {
            this.showToast('Please select a client.', 'yellow');
            return false;
        }
        return true;
    }

    // UI State Management Methods
    handleOpenDayState(unfinishedTasksExist) {
        if (unfinishedTasksExist) {
            this.updateButtonVisibility('taskInProgress');
            this.showTaskCompletionForm();
        } else {
            // When day is started but no tasks are in progress, show both start task and end day options
            this.startButton.style.display = 'block';
            this.endDayButton.style.display = 'block';
            this.startBreakButton.style.display = 'block';
            this.showStartTaskForm();
        }
    }

    handleNotStartedState() {
        this.updateButtonVisibility('dayNotStarted');
        this.hideInputFields();

        // Make sure task-related elements are hidden
        document.getElementById('type-input-container').style.display = 'none';
        document.getElementById('description-input-container').style.display = 'none';

        // Show the time picker for selecting start time
        document.getElementById('timepicker-container').style.display = 'block';
    }

    handleEndedDayState() {
        this.updateButtonVisibility('dayEnded');
        this.hideInputFields();
        document.getElementById('timepicker-container').style.display = 'none';
    }

    handleBreakState() {
        this.updateButtonVisibility('onBreak');
        this.hideInputFields();
    }

    showTaskCompletionForm(task) {
        // Display the form fields
        this.typeInput.style.display = 'block';
        this.descriptionInput.style.display = 'block';
        this.clientInput.style.display = 'block';

        if (task && task.client) {
            this.autocomplete.setChoiceByValue(task.client);
        }
    }

    showStartTaskForm() {
        // Show the client input container
        const clientContainer = this.clientInput.closest('.space-y-3');
        if (clientContainer) clientContainer.style.display = 'block';
        this.clientInput.style.display = 'block';
    }
    hideInputFields() {
        // Hide the client input container entirely, not just the input
        const clientContainer = this.clientInput.closest('.space-y-3');
        if (clientContainer) clientContainer.style.display = 'none';

        // Hide other inputs
        document.getElementById('type-input-container').style.display = 'none';
        document.getElementById('description-input-container').style.display = 'none';
    }

    updateButtonVisibility(state) {
        const buttons = {
            action: this.actionButton,
            complete: this.completeButton,
            start: this.startButton,
            startDay: this.startDayButton,
            endDay: this.endDayButton,
            startBreak: this.startBreakButton,
            endBreak: this.endBreakButton,
            reopenDay: this.reopenDayButton
        };

        // Hide all buttons first
        Object.values(buttons).forEach(button => {
            if (button) button.style.display = 'none';
        });

        // Show relevant buttons based on state
        switch (state) {
            case 'dayNotStarted':
                buttons.startDay.style.display = 'block';
                break;
            case 'dayStarted':
                buttons.start.style.display = 'block';
                buttons.startBreak.style.display = 'block';
                break;
            case 'taskInProgress':
                buttons.complete.style.display = 'block';
                break;
            case 'onBreak':
                buttons.endBreak.style.display = 'block';
                break;
            case 'dayEnded':
                buttons.reopenDay.style.display = 'block';
                break;
        }
    }


}
