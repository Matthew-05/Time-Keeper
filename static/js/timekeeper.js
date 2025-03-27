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
        this.descriptionInput = document.getElementById('description-input');
        this.descriptionContainer = document.getElementById('description-input-container');
        this.actionButton = document.getElementById('action-button');
        this.completeButton = document.getElementById('complete-button');
        this.startButton = document.getElementById('start-button');
        this.startDayButton = document.getElementById('start-day-button');
        this.endDayButton = document.getElementById('end-day-button');
        this.reopenDayButton = document.getElementById('reopen-day-button');
        this.timePicker = document.getElementById('timepicker');
        this.currentTimeButton = document.getElementById('current-time-button');
        this.taskStartTimeDisplay = document.getElementById('task-start-time');
    }


    initializeTimePicker() {
        this.timePickerInstance = flatpickr(this.timePicker, {
            enableTime: true,
            noCalendar: true,
            dateFormat: "h:i K",
        });
    }



    bindEvents() {
        this.startDayButton.addEventListener('click', () => this.handleStartDay());
        this.endDayButton.addEventListener('click', () => this.handleEndDay());
        this.startButton.addEventListener('click', () => this.startTask());
        this.completeButton.addEventListener('click', () => this.completeTask());
        this.reopenDayButton.addEventListener('click', () => this.handleReopenDay());
        this.currentTimeButton.addEventListener('click', () => this.setCurrentTime());
    }

    setCurrentTime() {
        const now = new Date();
        this.timePickerInstance.setDate(now);
        this.showToast('Time set to current time', 'success');
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
        const { dayStarted, unfinishedTasksExist, dayEnded } =
            await this.fetchFromAPI('/check_day_status');

        if (dayStarted && !dayEnded) {
            this.handleOpenDayState(unfinishedTasksExist);
        } else if (!dayStarted && !dayEnded) {
            this.handleNotStartedState();
        } else if (dayEnded) {
            this.handleEndedDayState();
        }
    }

    async checkUnfinishedTasks() {
        const tasks = await this.fetchFromAPI('/unfinished_tasks');
        if (tasks.length > 0) {
            const currentTask = tasks[0];

            // Make sure we have the client name before setting it
            if (currentTask && currentTask.client) {
                // Set the client in the autocomplete dropdown
                this.autocomplete.setChoiceByValue(currentTask.client);

                // Also set the value directly in the input field as a backup
                this.clientInput.value = currentTask.client;
            }

            // Show the description input container for task completion
            document.getElementById('description-input-container').style.display = 'block';

            this.showTaskCompletionForm(currentTask);
            this.completeButton.dataset.taskId = currentTask.id;
        } else {
            // Hide the description input container for starting a new task
            document.getElementById('description-input-container').style.display = 'none';

            this.showStartTaskForm();
        }
    }


    async handleStartDay() {
        try {
            // Validate time selection
            if (!this.timePicker.value) {
                this.showToast('Please select a start time.', 'error');
                return;
            }

            const response = await this.fetchFromAPI('/start_day', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time: this.timePicker.value })
            });

            // If we get here, the request was successful (fetchFromAPI would throw on error)
            this.showToast('Day started successfully', 'success');

            // Clear the time picker
            this.timePickerInstance.clear();

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



    async handleEndDay() {
        try {
            // Validate time selection
            if (!this.timePicker.value) {
                this.showToast('Please select an end time.', 'error');
                return;
            }

            // Then validate the selected time against business rules
            const isTimeValid = await this.validateSelectedTime();
            if (!isTimeValid) {
                return; // Stop if time validation fails
            }

            // Get the current time from the time picker
            const selectedTime = this.timePicker.value;

            // Call the API endpoint to end the day
            const response = await this.fetchFromAPI('/end_day', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ time: selectedTime })
            });

            // If successful, show a success message
            this.showToast('Day ended successfully', 'success');

            // Clear the time picker
            this.timePickerInstance.clear();

            // Update the UI to reflect the day has ended
            await this.checkDayStatus();

            // Update button visibility
            this.updateButtonVisibility('dayEnded');
        } catch (error) {
            console.error('Failed to end day:', error);
            // Error is already handled by fetchFromAPI with a toast
        }
    }




    getCurrentTimeIn12HourFormat() {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const formattedHours = hours % 12 || 12;
        const formattedMinutes = minutes.toString().padStart(2, '0');
        return `${formattedHours}:${formattedMinutes} ${ampm}`;
    }





    async startTask() {
        const clientName = this.clientInput.value;
        const selectedTime = this.timePicker.value;

        // Validate client selection
        if (!clientName) {
            this.showToast('Please select a client.', 'error');
            return;
        }

        // Validate time selection
        if (!selectedTime) {
            this.showToast('Please select a time.', 'error');
            return;
        }

        // Check if time is in the future
        const isNotFuture = await this.validateTimeNotInFuture(selectedTime);
        if (!isNotFuture) {
            return;
        }

        // Check if the selected time is valid (not before the most recent task end time)
        const isValidStartTime = await this.validateStartTime(selectedTime);
        if (!isValidStartTime) {
            return;
        }

        // Compare with current time if needed
        const currentTime = this.getCurrentTimeIn12HourFormat();
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
            this.timePickerInstance.clear();

            // Directly call the global startTimerWithTime function with the selected time
            if (window.startTimerWithTime) {
                window.startTimerWithTime(selectedTime);
            } else {
                console.error('startTimerWithTime function not found in global scope');
                // Fallback to the event-based approach
                document.dispatchEvent(new CustomEvent('taskStarted', {
                    detail: { startTime: selectedTime }
                }));
            }

            await this.checkDayStatus();
            await this.checkUnfinishedTasks();
        }
    }

    async validateStartTime(selectedTime) {
        try {
            // Get the most recent task end time for today
            const response = await this.fetchFromAPI('/most_recent_task_end_time');
            const mostRecentTaskEndTime = response.mostRecentTaskEndTime;

            if (mostRecentTaskEndTime) {
                // Convert both times to comparable format (24-hour)
                const selectedDateTime = new Date(`2000-01-01 ${selectedTime}`);
                const recentEndDateTime = new Date(`2000-01-01 ${mostRecentTaskEndTime}`);

                // Check if selected time is earlier than the most recent task end time
                if (selectedDateTime < recentEndDateTime) {
                    this.showToast(`Task start time cannot be earlier than the previous task's end time (${this.formatTimeDisplay(mostRecentTaskEndTime)})`, 'error');

                    // Reset the time picker to the most recent task end time
                    this.timePickerInstance.setDate(recentEndDateTime);
                    return false;
                }
            }

            return true;
        } catch (error) {
            console.error('Error validating start time:', error);
            this.showToast('Error validating start time', 'error');
            return false;
        }
    }




    clearInputs() {
        this.clientInput.value = '';
        this.descriptionInput.value = '';
        // Clear the time picker
        this.timePickerInstance.clear();
    }





    async completeTask() {
        // Validate time selection
        if (!this.timePicker.value) {
            this.showToast('Please select a completion time.', 'error');
            return;
        }

        // Validate the selected time against business rules
        const isTimeValid = await this.validateSelectedTime();
        if (!isTimeValid) {
            return; // Stop if time validation fails
        }

        const response = await this.fetchFromAPI('/complete_task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client: this.clientInput.value,
                description: this.descriptionInput.value,
                endTime: this.timePicker.value
            })
        });

        if (response.success) {
            this.showToast(`Task completed successfully for client: ${this.clientInput.value}`, 'green');
            this.clearInputs();
            // Clear the time picker
            this.timePickerInstance.clear();
            this.autocomplete.setChoiceByValue('');
            this.completeButton.style.display = 'none';
            this.startButton.style.display = 'block';

            // Hide the task start time display
            this.taskStartTimeDisplay.classList.add('hidden');
            this.taskStartTimeDisplay.textContent = '';

            // Stop and reset the timer in the navbar
            if (window.stopAndResetTimer) {
                window.stopAndResetTimer();
            } else {
                // Dispatch a custom event as fallback
                document.dispatchEvent(new CustomEvent('taskCompleted'));
            }

            await this.checkDayStatus();
            await this.checkUnfinishedTasks();
        }
    }

    formatTimeDisplay(timeString) {
        if (!timeString) return '';

        // Parse the time string (assuming format like "HH:MM:SS" or "HH:MM:SS AM/PM")
        let timeParts = timeString.split(' ');
        let timeValue = timeParts[0];
        let ampm = timeParts.length > 1 ? timeParts[1] : '';

        // Split hours, minutes, seconds
        let [hours, minutes, seconds] = timeValue.split(':');

        // Remove leading zero from hours if present
        if (hours.startsWith('0')) {
            hours = hours.substring(1);
        }

        // If no AM/PM is provided in the string but hours > 12, convert to 12-hour format
        if (!ampm) {
            if (parseInt(hours) > 12) {
                hours = (parseInt(hours) - 12).toString();
                ampm = 'PM';
            } else if (parseInt(hours) === 12) {
                ampm = 'PM';
            } else if (parseInt(hours) === 0) {
                hours = '12';
                ampm = 'AM';
            } else {
                ampm = 'AM';
            }
        }

        // Return formatted time without seconds
        return `${hours}:${minutes} ${ampm}`;
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
            this.showStartTaskForm();
        }
    }


    handleNotStartedState() {
        this.updateButtonVisibility('dayNotStarted');
        this.hideInputFields();

        // Make sure task-related elements are hidden
        document.getElementById('description-input-container').style.display = 'none';

        // Show the time picker for selecting start time
        document.getElementById('timepicker-container').style.display = 'block';
    }

    handleEndedDayState() {
        this.updateButtonVisibility('dayEnded');
        this.hideInputFields();

        // Hide the client selector specifically
        if (this.autocomplete && this.autocomplete.containerOuter) {
            this.autocomplete.containerOuter.element.style.display = 'none';
        }

        // Also hide the client input container
        const clientContainer = this.clientInput.closest('.space-y-3');
        if (clientContainer) clientContainer.style.display = 'none';

        // Hide the time picker container as well
        document.getElementById('timepicker-container').style.display = 'none';
    }




    showTaskCompletionForm(task) {
        // Display the form fields
        this.descriptionInput.style.display = 'block';
        this.clientInput.style.display = 'block';

        // Make sure type and description containers are visible
        document.getElementById('description-input-container').style.display = 'block';

        // Always ensure client is set if available
        if (task && task.client) {
            // Set in autocomplete
            this.autocomplete.setChoiceByValue(task.client);

            // Also set directly in input as fallback
            this.clientInput.value = task.client;

            console.log("Setting client to:", task.client);
        }

        // Display the task start time if available
        if (task && task.start_time) {
            const formattedTime = this.formatTimeDisplay(task.start_time);
            this.taskStartTimeDisplay.textContent = `${formattedTime} -`;
            this.taskStartTimeDisplay.classList.remove('hidden');
        }
    }




    showStartTaskForm() {
        // Show the client input container
        const clientContainer = this.clientInput.closest('.space-y-3');
        if (clientContainer) clientContainer.style.display = 'block';
        this.clientInput.style.display = 'block';

        // Hide the description input container since we're starting a new task
        document.getElementById('description-input-container').style.display = 'none';

        // Hide the task start time display
        this.taskStartTimeDisplay.classList.add('hidden');
        this.taskStartTimeDisplay.textContent = '';
    }

    hideInputFields() {
        // Hide the client input container entirely, not just the input
        const clientContainer = this.clientInput.closest('.space-y-3');
        if (clientContainer) clientContainer.style.display = 'none';

        // Hide other input
        document.getElementById('description-input-container').style.display = 'none';
    }

    updateButtonVisibility(state) {
        const buttons = {
            action: this.actionButton,
            complete: this.completeButton,
            start: this.startButton,
            startDay: this.startDayButton,
            endDay: this.endDayButton,
            reopenDay: this.reopenDayButton
        };

        // Hide all buttons first
        Object.values(buttons).forEach(button => {
            if (button) button.style.display = 'none';
        });

        // Show relevant buttons based on state
        switch (state) {
            case 'dayNotStarted':
                buttons.startDay.style.display = 'flex';
                break;
            case 'dayStarted':
                buttons.start.style.display = 'flex';
                buttons.endDay.style.display = 'flex';
                break;
            case 'taskInProgress':
                buttons.complete.style.display = 'flex';
                break;
            case 'dayEnded':
                buttons.reopenDay.style.display = 'flex';
                break;
        }
    }




    async validateTimeNotInFuture(selectedTime) {
        // Parse the selected time (in 12-hour format like "1:30 PM")
        const [timePart, ampmPart] = selectedTime.split(' ');
        const [hours, minutes] = timePart.split(':').map(Number);

        // Convert to 24-hour format
        let hours24 = hours;
        if (ampmPart.toUpperCase() === 'PM' && hours < 12) {
            hours24 += 12;
        } else if (ampmPart.toUpperCase() === 'AM' && hours === 12) {
            hours24 = 0;
        }

        // Create Date objects for comparison
        const now = new Date();
        const selectedDateTime = new Date();
        selectedDateTime.setHours(hours24, minutes, 0, 0);

        // Check if selected time is in the future
        if (selectedDateTime > now) {
            this.showToast('Cannot select a time in the future', 'error');
            return false;
        }

        return true;
    }



    async validateSelectedTime() {
        // Get the selected time from the time picker
        const selectedTime = this.timePicker.value;

        if (!selectedTime) {
            this.showToast('Please select a time', 'error');
            return false;
        }

        // First check if the time is in the future
        const isNotFuture = await this.validateTimeNotInFuture(selectedTime);
        if (!isNotFuture) {
            return false;
        }

        try {
            // Get the most recent end time from the backend
            const response = await this.fetchFromAPI('/most_recent_end_time');
            const mostRecentEndTime = response.mostRecentEndTime;

            if (mostRecentEndTime) {
                // Convert both times to comparable format (24-hour)
                const selectedDateTime = new Date(`2000-01-01 ${selectedTime}`);
                const recentEndDateTime = new Date(`2000-01-01 ${mostRecentEndTime}`);

                // Check if selected time is earlier than the most recent end time
                if (selectedDateTime < recentEndDateTime) {
                    this.showToast(`Selected time cannot be earlier than ${mostRecentEndTime}`, 'error');

                    // Reset the time picker to the most recent end time
                    const hours = recentEndDateTime.getHours();
                    const minutes = recentEndDateTime.getMinutes();
                    const ampm = hours >= 12 ? 'PM' : 'AM';
                    const formattedHours = hours % 12 || 12;
                    const formattedMinutes = minutes.toString().padStart(2, '0');
                    const timeString = `${formattedHours}:${formattedMinutes} ${ampm}`;

                    this.timePickerInstance.setDate(recentEndDateTime);
                    return false;
                }
            }

            return true;
        } catch (error) {
            console.error('Error validating selected time:', error);
            this.showToast('Error validating time', 'error');
            return false;
        }
    }


    async handleReopenDay() {
        try {
            // Call the API endpoint to reopen the day
            const response = await this.fetchFromAPI('/reopen_day', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' }
            });

            // If successful, show a success message
            this.showToast('Day reopened successfully', 'success');
            document.getElementById('reopen-day-button').style.display = 'none';

            // Check for unfinished tasks
            const tasks = await this.fetchFromAPI('/unfinished_tasks');

            // Update the UI based on whether there are unfinished tasks
            if (tasks.length > 0) {
                // If there are unfinished tasks, show the task completion form
                this.handleOpenDayState(true);
                this.showTaskCompletionForm(tasks[0]);
                this.completeButton.dataset.taskId = tasks[0].id;

                // Set the client in the autocomplete
                if (this.autocomplete) {
                    this.autocomplete.setChoiceByValue(tasks[0].client);
                }
            } else {
                // If there are no unfinished tasks, show the start task form
                this.handleOpenDayState(false);
                this.showStartTaskForm();

                // Make sure the client selector is visible
                const clientContainer = this.clientInput.closest('.space-y-3');
                if (clientContainer) clientContainer.style.display = 'block';

                // Show the time picker
                document.getElementById('timepicker-container').style.display = 'block';
            }

            // Initialize autocomplete if needed
            if (!this.autocomplete) {
                await this.initializeAutocomplete();
            } else if (this.autocomplete.containerOuter) {
                // Make sure the autocomplete is visible
                this.autocomplete.containerOuter.element.style.display = 'block';
            }

            // Update day status to reflect changes
            await this.checkDayStatus();
        } catch (error) {
            console.error('Failed to reopen day:', error);
            // Error is already handled by fetchFromAPI with a toast
        }
    }




}
