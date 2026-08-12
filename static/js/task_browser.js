import { TimeKeeper, createPoller, reconcileChildren, setText, setHtml, ready, clientColor, clientForeground, confirmAction, lockBodyScroll, unlockBodyScroll } from './base.js';
import { WorksList, fetchWorks, joinWorks } from './works.js';
import {
    clockTimeToDate,
    clockTimeToSeconds,
    currentClockTime,
    flatpickrTimeFormat,
    flatpickrTimeOptions,
    formatClockTime,
    serializeClockTime,
    visTimelineTimeFormat,
} from './time_format.js';
import { flatpickrCalendarOptions } from './week_start.js';
import { localDate } from './calendar_dates.js';

/** The id of the one editable item on the Add task timeline. */
const ADD_TASK_DRAFT_ID = 'draft';

/**
 * Dragging resolution. Five minutes matches how people describe a block of
 * work; the pickers are still free to the minute for anyone who needs it.
 */
const ADD_TASK_SNAP_MS = 5 * 60 * 1000;

/** A draft can't be squashed below this, or it would save as nothing. */
const ADD_TASK_MIN_MINUTES = 5;

/**
 * Collapse touching task ranges for the same active client into one visual
 * range. The input is chronological and the returned objects are copies, so
 * the task table and summary can continue using the original records.
 */
export function mergeAdjacentClientTasks(tasks) {
    return tasks.reduce((ranges, task) => {
        const previous = ranges[ranges.length - 1];
        const sameClient = previous
            && task.client_id != null
            && previous.client_id === task.client_id;
        const rangesTouch = sameClient
            && clockTimeToSeconds(previous.end_time) === clockTimeToSeconds(task.start_time);

        if (sameClient && rangesTouch) {
            previous.end_time = task.end_time;
            previous.is_ongoing = Boolean(task.is_ongoing);
            return ranges;
        }

        ranges.push({ ...task });
        return ranges;
    }, []);
}

export class TaskBrowser extends TimeKeeper {
    constructor() {
        super();
        this.isLoading = false;
        this.initializeElements();
        this.initializeWorksModal();
        this.initializeAddTaskModal();
        this.initializeTimePicker();
        this.initializeDayTimePickers();
        // Floating this promise un-caught meant any failure during startup
        // aborted the chain silently and left the page on its placeholders.
        this.fetchInitialData().catch((error) => {
            console.error('Initial load failed:', error);
        });
        this.initializeTaskEditing();
        document.addEventListener('timeFormatChanged', () => this.handleTimeFormatChanged());

        // Only today's view goes stale on its own — a past date is settled, so
        // re-fetching it every minute is pure noise. Returning early leaves the
        // poller scheduled, so switching back to today picks up on the next
        // boundary without anything having to restart it.
        //
        // `background: true` is what keeps this invisible: no spinner, rows
        // patched rather than rebuilt, timeline updated through its DataSet.
        this.tasksPoller = createPoller(async () => {
            if (this.selectedDate.value !== this.getLocalDateString()) return;
            await this.fetchTasks({ background: true });
        }, {
            name: 'task-browser',
            shouldSkip: () => this.isBusy(),
        });
    }

    /**
     * Is the user in the middle of something a refresh shouldn't land on?
     *
     * Patching in place already means a refresh doesn't destroy the page, but
     * these three states involve values the user is actively working with, and
     * changing the data underneath them is confusing even when it's done
     * gracefully. The tick is deferred and `resume()` collects it the moment
     * they finish, so nothing is lost by waiting.
     */
    isBusy() {
        // Works modal open: it's reading a client's works for this day, and
        // the row behind it is the thing that would move.
        if (this.worksModal && !this.worksModal.classList.contains('hidden')) return true;

        // Add task open: it holds times chosen against the gaps as they were
        // when it opened, and a refresh would move the table underneath it.
        if (this.addTaskModal && !this.addTaskModal.classList.contains('hidden')) return true;

        // A task row mid-edit, with unsaved times in its pickers.
        if (document.querySelector('#tasks-tbody .tk-row-editing')) return true;

        // The day start/close fields, which reveal their Save/Cancel actions
        // only once the value has been touched. These toggle
        // action-buttons-visible rather than `hidden` — see .tk-time-text-actions
        // in app.css, which animates them rather than switching display.
        if (this.dayStartActions?.classList.contains('action-buttons-visible')) return true;
        if (this.dayEndActions?.classList.contains('action-buttons-visible')) return true;

        return false;
    }

    /** Collect a refresh that isBusy() deferred. No-op if none was skipped. */
    resumeRefresh() {
        this.tasksPoller?.resume().catch((error) => console.error(error));
    }

    /** Stop the refresh poller. See the note on TimeKeeperIndex.destroy(). */
    destroy() {
        this.tasksPoller?.stop();
        this.destroyAddTaskTimeline();
        // #loadTasks queues this on failure and it retries indefinitely, so a
        // page torn down mid-outage would otherwise keep one alive.
        clearTimeout(this.reloadTimer);
    }

    initializeElements() {
        this.selectedDate = document.getElementById('selected-date');
        this.dayStartTime = document.getElementById('day-start-time');
        this.dayEndTime = document.getElementById('day-end-time');
        
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
        
        this.datePicker = flatpickr(this.selectedDate, flatpickrCalendarOptions({
            defaultDate: new Date(),
            dateFormat: "Y-m-d",
            onChange: () => this.fetchTasks()
        }));

        // Prev/next day buttons
        this.prevDayBtn = document.getElementById('prev-day-btn');
        this.nextDayBtn = document.getElementById('next-day-btn');
        if (this.prevDayBtn) this.prevDayBtn.addEventListener('click', () => this.navigateDay(-1));
        if (this.nextDayBtn) this.nextDayBtn.addEventListener('click', () => this.navigateDay(1));

        // Bind action buttons
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
        this.dayStartTimePicker = flatpickr(this.dayStartTime, flatpickrTimeOptions({
            onChange: () => {
                this.showTimeActions('start');
            }
        }));

        this.dayEndTimePicker = flatpickr(this.dayEndTime, flatpickrTimeOptions({
            onChange: () => {
                this.showTimeActions('end');
            }
        }));
    }

    reconfigureTimePicker(picker) {
        if (!picker) return
        const selected = picker.selectedDates[0]
        const options = flatpickrTimeFormat()
        picker.set('time_24hr', options.time_24hr)
        picker.set('dateFormat', options.dateFormat)
        if (selected) picker.setDate(selected, false)
    }

    handleTimeFormatChanged() {
        this.reconfigureTimePicker(this.dayStartTimePicker)
        this.reconfigureTimePicker(this.dayEndTimePicker)
        this.reconfigureTimePicker(this.addTaskStartPicker)
        this.reconfigureTimePicker(this.addTaskEndPicker)
        document.querySelectorAll('.task-time-picker').forEach((input) => {
            this.reconfigureTimePicker(input._flatpickr)
        })
        document.querySelectorAll('[data-clock-time]').forEach((element) => {
            element.textContent = formatClockTime(element.dataset.clockTime)
        })
        const axisFormat = { format: visTimelineTimeFormat() }
        if (this.timeline) this.timeline.setOptions(axisFormat)
        // The Add task timeline carries the format in its tooltips as well as
        // its axis, so the draft is rewritten rather than just reconfigured.
        if (this.addTaskTimeline) {
            this.addTaskTimeline.setOptions(axisFormat)
            this.syncDraftItem()
        }
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
            const canonicalTime = serializeClockTime(timeStr)
            const response = await this.fetchFromAPI('/update_day_time', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    date: this.selectedDate.value,
                    type: type,
                    time: canonicalTime
                })
            });

            if (response.success) {
                const message = type === 'end'
                    ? 'Day closed successfully'
                    : 'Day start time updated successfully';
                this.showToast(message, 'success');
                
                // Update the original value and flatpickr default
                if (type === 'start') {
                    this.originalStartTime = canonicalTime;
                    this.dayStartTimePicker.setDate(clockTimeToDate(canonicalTime), false);
                } else {
                    this.originalEndTime = canonicalTime;
                    this.dayEndTimePicker.setDate(clockTimeToDate(canonicalTime), false);
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
            if (this.originalStartTime) this.dayStartTimePicker.setDate(clockTimeToDate(this.originalStartTime));
            else this.dayStartTimePicker.clear();
        } else {
            if (this.originalEndTime) this.dayEndTimePicker.setDate(clockTimeToDate(this.originalEndTime));
            else this.dayEndTimePicker.clear();
        }
        
        // Hide action buttons
        this.hideTimeActions(type);
        this.resumeRefresh();
    }

    initializeTaskEditing() {
        document.addEventListener('click', e => {
            // Handle delete button clicks separately
            if (e.target.classList.contains('delete-task-btn')) {
                const row = e.target.closest('tr');
                confirmAction(e.target, () => this.handleTaskDelete(row));
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

        if (this.worksModal.classList.contains('hidden')) {
            this.worksModal.classList.remove('hidden');
            lockBodyScroll();
        }
        // force: the same client can be reopened after an edit elsewhere, and
        // setTarget would otherwise treat an unchanged target as a no-op and
        // show a stale list.
        await this.worksList.setTarget(dateStr, client.id, { force: true });

        const input = this.worksModal.querySelector('.works-add-input');
        if (input) input.focus();
    }

    closeWorksModal() {
        if (!this.worksModal || this.worksModal.classList.contains('hidden')) return;
        this.worksModal.classList.add('hidden');
        this.worksModalClient = null;
        unlockBodyScroll();

        // Refreshes were deferred for as long as this was open; the table
        // behind it may be several minutes behind by now.
        this.resumeRefresh();
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

    // ---- Add task ----------------------------------------------------------

    initializeAddTaskModal() {
        this.addTaskModal = document.getElementById('add-task-modal');
        if (!this.addTaskModal) return;

        this.addTaskSubtitle = document.getElementById('add-task-subtitle');
        this.addTaskClient = document.getElementById('add-task-client');
        this.addTaskStart = document.getElementById('add-task-start');
        this.addTaskEnd = document.getElementById('add-task-end');
        this.addTaskWarning = document.getElementById('add-task-warning');
        this.addTaskSave = document.getElementById('add-task-save');
        this.addTaskWorksSection = document.getElementById('add-task-works');
        this.addTaskTimelineWrap = document.getElementById('add-task-timeline-wrap');
        this.addTaskTimelineEl = document.getElementById('add-task-timeline');

        // Set when the server has asked to confirm a change to the day's
        // bounds. The next Save re-sends the same task with permission.
        this.addTaskStretchConfirmed = false;
        // The live timeline, its DataSet, and the payload both were built from.
        this.addTaskTimeline = null;
        this.addTaskItems = null;
        this.addTaskDayData = null;

        this.addTaskStartPicker = flatpickr(this.addTaskStart, flatpickrTimeOptions({
            minuteIncrement: 1,
            onChange: () => this.handleAddTaskTimeChanged(),
        }));
        this.addTaskEndPicker = flatpickr(this.addTaskEnd, flatpickrTimeOptions({
            minuteIncrement: 1,
            onChange: () => this.handleAddTaskTimeChanged(),
        }));

        // The same list the Today page and the Works modal render. Works are
        // keyed on (client, day) rather than on a task, so it can be filled in
        // before — or entirely without — the task that prompted opening this.
        this.addTaskWorks = new WorksList({
            container: document.getElementById('add-task-works-list'),
            api: this,
        });
        this.addTaskWorksDirty = false;

        document.getElementById('add-task-btn')
            .addEventListener('click', () => this.openAddTaskModal());
        document.getElementById('add-task-close')
            .addEventListener('click', () => this.closeAddTaskModal());
        document.getElementById('add-task-cancel')
            .addEventListener('click', () => this.closeAddTaskModal());
        this.addTaskSave.addEventListener('click', () => this.submitAddTask());
        this.addTaskClient.addEventListener('change', () => this.syncAddTaskWorks());

        // Any works CRUD inside the modal changes the counts in the table
        // behind it, so note that a refresh is owed on close. Delegated on the
        // container because the list rebuilds its own markup constantly.
        this.addTaskWorksSection.addEventListener('click', (e) => {
            if (e.target.closest('button')) this.addTaskWorksDirty = true;
        });
        this.addTaskWorksSection.addEventListener('submit', () => {
            this.addTaskWorksDirty = true;
        });

        this.addTaskModal.addEventListener('click', (e) => {
            if (e.target === this.addTaskModal) this.closeAddTaskModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.addTaskModal.classList.contains('hidden')) {
                this.closeAddTaskModal();
            }
        });
    }

    async openAddTaskModal() {
        if (!this.addTaskModal) return;

        const dateStr = this.selectedDate.value;
        this.addTaskSubtitle.textContent = this.formatDateLong(dateStr);
        this.resetAddTaskConfirmation();
        this.addTaskStartPicker.clear();
        this.addTaskEndPicker.clear();
        this.addTaskWorksDirty = false;
        this.addTaskWorksSection.classList.add('hidden');
        this.destroyAddTaskTimeline();

        // `this.clients` is filled by renderTasks, which is exactly the load
        // that fails to run when there's nothing to render — and a day with no
        // tasks is the most likely day to be adding one to.
        if (!this.clients?.length) {
            try {
                this.clients = await this.fetchFromAPI('/clients');
            } catch (error) {
                console.error('Could not load clients:', error);
                this.showToast('Could not load clients', 'error');
                return;
            }
        }
        setHtml(this.addTaskClient, this.getClientOptions(null, { placeholder: 'Select a client…' }));
        this.addTaskClient.selectedIndex = 0;

        this.addTaskModal.classList.remove('hidden');
        lockBodyScroll();
        this.addTaskClient.focus();

        // After the modal is up, and not before: vis-timeline measures its
        // container on construction, and one built inside a `hidden` backdrop
        // comes out zero-width and stays that way.
        await this.loadAddTaskTimeline(dateStr);
    }

    // ---- The day timeline --------------------------------------------------

    /**
     * Draw the day, and let the new task be picked and dragged on it.
     *
     * The same vis-timeline the page itself uses, so a range means the same
     * thing in both places and the two read as one screen. Three kinds of item
     * share the single lane:
     *
     *  - **Recorded tasks**, `editable: false`. Context, not targets — they're
     *    what makes an untracked stretch mean something.
     *  - **Untracked stretches**, as `background` items. vis reports a click on
     *    one as a click on empty canvas rather than on an item, so they're
     *    matched by the clicked *time* instead of by id, which also means the
     *    axis and the padding either side behave the same way.
     *  - **The draft**, the only editable item on the timeline. Dragging its
     *    body moves it; dragging an edge resizes it; both write straight back
     *    into the two time fields.
     */
    async loadAddTaskTimeline(dateStr) {
        let response;
        try {
            response = await this.fetchFromAPI(`/api/day-timeline/${dateStr}`);
        } catch (error) {
            // The timeline is a convenience; the two time fields work perfectly
            // well without it, so this stays silent and just hides it.
            console.error('Could not load the day timeline:', error);
            this.addTaskTimelineWrap.classList.add('hidden');
            return;
        }

        // The date can be changed behind an open modal, and a late response
        // would then describe a day the form is no longer about.
        if (this.selectedDate.value !== dateStr) return;

        this.addTaskDayData = response;
        this.buildAddTaskTimeline(dateStr);

        if (response.suggested) {
            this.applyRange(response.suggested.start_time, response.suggested.end_time);
        }
    }

    buildAddTaskTimeline(dateStr) {
        const data = this.addTaskDayData;
        if (!data) return;

        this.destroyAddTaskTimeline();
        this.addTaskTimelineWrap.classList.remove('hidden');

        const at = (clock) => `${dateStr}T${clock}:00`;
        const items = [];

        for (const gap of data.gaps) {
            items.push({
                id: `gap-${gap.start_time}`,
                type: 'background',
                className: 'tk-add-task-gap',
                start: at(gap.start_time),
                end: at(gap.end_time),
                editable: false,
                selectable: false,
            });
        }

        for (const task of data.tasks) {
            const label = this.escapeHtml(task.client);
            items.push({
                id: `task-${task.id}`,
                type: 'range',
                className: `tk-timeline-range tk-add-task-recorded${task.ongoing ? ' is-ongoing' : ''}`,
                content: `<span class="tk-timeline-item"><span class="tk-timeline-item-client">${label}</span></span>`,
                title: `<div class="tk-timeline-tooltip"><strong>${label}</strong>`
                    + `<span>${this.rangeLabel(task)}</span>`
                    + `<span>${task.ongoing ? 'Ongoing' : 'Recorded'}</span></div>`,
                start: at(task.start_time),
                end: at(task.end_time),
                // Recorded time is context here. It's edited in the table below,
                // where the change is explicit and has a Save button.
                editable: false,
                selectable: false,
                style: `background-color: ${clientColor(task.client)}; color: ${clientForeground(task.client)};`,
            });
        }

        this.addTaskItems = new vis.DataSet(items);

        const timeline = new vis.Timeline(this.addTaskTimelineEl, this.addTaskItems, {
            start: at(data.window.start_time),
            end: at(data.window.end_time),
            min: `${dateStr}T00:00:00`,
            max: `${dateStr}T23:59:59`,
            orientation: 'top',
            stack: false,
            verticalScroll: false,
            zoomKey: 'ctrlKey',
            zoomMin: 30 * 60 * 1000,
            zoomMax: 24 * 60 * 60 * 1000,
            height: '132px',
            margin: { axis: 10, item: { horizontal: 0, vertical: 12 } },
            showCurrentTime: dateStr === this.getLocalDateString(),
            format: visTimelineTimeFormat(),
            tooltip: { followMouse: true, overflowMethod: 'cap' },
            // Global editing is on so the draft can be dragged; every other item
            // opts out individually. `overrideItems` stays false — true would
            // make this win over those opt-outs and turn recorded time into
            // something you can drag by accident.
            editable: {
                add: false,
                remove: false,
                updateGroup: false,
                updateTime: true,
                overrideItems: false,
            },
            snap: (date) => new Date(Math.round(date.valueOf() / ADD_TASK_SNAP_MS) * ADD_TASK_SNAP_MS),
            onMoving: (item, callback) => this.handleDraftMoving(item, callback),
            onMove: (item, callback) => this.handleDraftMoved(item, callback),
        });

        timeline.on('click', (props) => {
            // Anything with an id is an item — the draft, or recorded time.
            // Both are handled by dragging, not by clicking.
            if (props.item != null || !props.time) return;
            const gap = this.gapAt(this.dateToMinutes(props.time));
            if (gap) this.applyRange(gap.start_time, gap.end_time);
        });

        // Where the day itself begins and ends, which the drawn window doesn't
        // say — a task dragged past the close marker is visibly outside the day
        // before the confirmation explains that saving it will move the close.
        const marker = (clock, id, label) => {
            if (!clock) return;
            timeline.addCustomTime(at(clock), id);
            timeline.setCustomTimeTitle(`${label}: ${formatClockTime(clock)}`, id);
        };
        marker(data.day?.start_time, 'tk-day-start', 'Start');
        marker(data.day?.end_time, 'tk-day-close', 'Close');

        this.addTaskTimeline = timeline;
        this.syncDraftItem();
    }

    destroyAddTaskTimeline() {
        this.addTaskTimeline?.destroy();
        this.addTaskTimeline = null;
        this.addTaskItems = null;
        this.addTaskDayData = null;
    }

    /** The untracked stretch containing `minute`, or null. */
    gapAt(minute) {
        return (this.addTaskDayData?.gaps ?? []).find((gap) => (
            minute >= this.clockToMinutes(gap.start_time)
            && minute < this.clockToMinutes(gap.end_time)
        )) ?? null;
    }

    /**
     * The bounds a draft proposed at `[start, end)` may be held within, or null
     * if it isn't over untracked time at all.
     *
     * The gaps are the free regions by construction, so the walls are whichever
     * gap the draft is most inside — **by overlap**, not by where its midpoint
     * falls. Midpoints fail at exactly the moment this matters: drag a
     * two-hour draft thirty minutes past the wall at 14:00 and its midpoint
     * lands on 14:00, which is in no gap (they're half-open), so the frame
     * would be refused at the one point it most needs clamping. Overlap has no
     * such boundary, and picking the largest is also what makes a draft dragged
     * clean across a task land in the gap on the far side.
     */
    draftBounds(start, end) {
        let bounds = null;
        let best = 0;

        for (const gap of this.addTaskDayData?.gaps ?? []) {
            const low = this.clockToMinutes(gap.start_time);
            const high = this.clockToMinutes(gap.end_time);
            const overlap = Math.min(end, high) - Math.max(start, low);
            if (overlap > best) {
                best = overlap;
                bounds = [low, high];
            }
        }

        return bounds;
    }

    /**
     * Live during a drag: hold the draft inside its stretch and write it back.
     *
     * Clamping rather than rejecting the frame. Rejecting leaves the item
     * wherever the last accepted frame put it, so dragging quickly at a wall
     * stops short of it by however far the pointer moved between frames;
     * clamping lands exactly on the wall every time.
     */
    handleDraftMoving(item, callback) {
        if (item.id !== ADD_TASK_DRAFT_ID) return callback(null);

        let start = this.dateToMinutes(item.start);
        let end = this.dateToMinutes(item.end);

        // The floor is applied *before* the walls are chosen. Dragging one edge
        // past the other proposes a zero-length range, which overlaps nothing,
        // which would leave it with no walls and get the frame refused — the
        // draft would stick the moment it was squashed flat.
        if (end - start < ADD_TASK_MIN_MINUTES) end = start + ADD_TASK_MIN_MINUTES;

        const bounds = this.draftBounds(start, end);

        if (!bounds) {
            // Not over untracked time at all. Refuse the frame: vis leaves the
            // item where it was and keeps proposing positions from the pointer,
            // so a drag across a task simply resumes on the far side rather
            // than dropping the draft on top of it.
            return callback(null);
        }

        const [low, high] = bounds;
        // Move the whole span back inside the wall it hit, rather than
        // squashing it — a body drag must keep its length. Capping the span at
        // the region's own width is what handles a stretch shorter than the
        // floor: a three-minute gap yields a three-minute draft rather than a
        // five-minute one hanging over the task next to it.
        const span = Math.min(end - start, high - low);
        if (start < low) { start = low; end = low + span; }
        if (end > high) { end = high; start = high - span; }

        item.start = this.minutesToDate(start);
        item.end = this.minutesToDate(end);
        this.setAddTaskTimes(this.minutesToClock(start), this.minutesToClock(end));
        callback(item);
    }

    handleDraftMoved(item, callback) {
        if (item.id !== ADD_TASK_DRAFT_ID) return callback(null);
        this.setAddTaskTimes(
            this.minutesToClock(this.dateToMinutes(item.start)),
            this.minutesToClock(this.dateToMinutes(item.end)),
        );
        callback(item);
    }

    /** Put the draft on the timeline where the two time fields say it is. */
    syncDraftItem() {
        if (!this.addTaskItems) return;

        const start = this.fieldMinutes(this.addTaskStart);
        const end = this.fieldMinutes(this.addTaskEnd);
        if (start == null || end == null || end <= start) {
            if (this.addTaskItems.get(ADD_TASK_DRAFT_ID)) {
                this.addTaskItems.remove(ADD_TASK_DRAFT_ID);
            }
            return;
        }

        this.addTaskItems.update({
            id: ADD_TASK_DRAFT_ID,
            type: 'range',
            className: 'tk-timeline-range tk-add-task-draft',
            content: '<span class="tk-timeline-item"><span class="tk-timeline-item-client">New task</span></span>',
            title: `<div class="tk-timeline-tooltip"><strong>New task</strong>`
                + `<span>${formatClockTime(this.minutesToClock(start))} – ${formatClockTime(this.minutesToClock(end))}</span>`
                + `<span>Drag to move, drag an edge to resize</span></div>`,
            start: this.minutesToDate(start),
            end: this.minutesToDate(end),
            editable: { updateTime: true, updateGroup: false, remove: false },
            selectable: true,
        });
    }

    clockToMinutes(clock) {
        return Math.round(clockTimeToSeconds(clock) / 60);
    }

    minutesToClock(minutes) {
        const whole = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
        return serializeClockTime({ hours: Math.floor(whole / 60), minutes: whole % 60 });
    }

    /** A vis item boundary (Date or parseable value) as minutes past midnight. */
    dateToMinutes(value) {
        const date = value instanceof Date ? value : new Date(value);
        return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
    }

    /** Minutes past midnight, on the browsed date, as a Date for vis. */
    minutesToDate(minutes) {
        return clockTimeToDate(this.minutesToClock(minutes), localDate(this.selectedDate.value));
    }

    /**
     * One time field as minutes, or null if it doesn't hold a time.
     *
     * The pickers are read-only so the value is always well-formed in practice,
     * but this runs on every drag frame and a throw here would take the whole
     * dialog's interaction with it.
     */
    fieldMinutes(input) {
        if (!input?.value) return null;
        try {
            return this.clockToMinutes(serializeClockTime(input.value));
        } catch {
            return null;
        }
    }

    rangeLabel({ start_time: from, end_time: to }) {
        return `${formatClockTime(from)} – ${formatClockTime(to)}`;
    }

    /**
     * Write both time fields without letting flatpickr call back.
     *
     * `setDate(..., false)` suppresses onChange, which is what stops a drag
     * frame turning into a picker change that redraws the item being dragged.
     * The bookkeeping onChange would have done is therefore done here instead.
     */
    setAddTaskTimes(startClock, endClock) {
        this.addTaskStartPicker.setDate(clockTimeToDate(startClock), false);
        this.addTaskEndPicker.setDate(clockTimeToDate(endClock), false);
        this.resetAddTaskConfirmation();
    }

    /** Load a start/end pair into the form and onto the timeline. */
    applyRange(start, end) {
        this.setAddTaskTimes(start, end);
        this.syncDraftItem();
    }

    /** A time field was edited by hand; the draft follows it. */
    handleAddTaskTimeChanged() {
        this.resetAddTaskConfirmation();
        this.syncDraftItem();
    }

    // ---- Works, client, lifecycle ------------------------------------------

    /** Point the works list at whichever client is selected, or hide it. */
    async syncAddTaskWorks() {
        const clientId = parseInt(this.addTaskClient.value, 10);
        if (Number.isNaN(clientId)) {
            this.addTaskWorksSection.classList.add('hidden');
            return;
        }
        this.addTaskWorksSection.classList.remove('hidden');
        try {
            await this.addTaskWorks.setTarget(this.selectedDate.value, clientId, { force: true });
        } catch (error) {
            console.error('Could not load works:', error);
        }
    }

    /**
     * Drop back to the ordinary Save state.
     *
     * Any edit to the times invalidates an agreement to move the day's bounds —
     * the confirmation was about a specific stretch, and a second click after
     * changing the values would otherwise apply it to a different one.
     */
    resetAddTaskConfirmation() {
        this.addTaskStretchConfirmed = false;
        this.addTaskWarning?.classList.add('hidden');
        if (this.addTaskSave) this.addTaskSave.textContent = 'Add task';
    }

    closeAddTaskModal() {
        if (!this.addTaskModal || this.addTaskModal.classList.contains('hidden')) return;
        this.addTaskModal.classList.add('hidden');
        // vis-timeline keeps window listeners and a hammer.js instance per
        // instance, so the one built for this session goes with the dialog
        // rather than being left behind for the next open to stack on.
        this.destroyAddTaskTimeline();
        unlockBodyScroll();

        // Works save as they're typed, so closing without adding the task can
        // still have changed the Works column behind this. resumeRefresh only
        // collects a tick the poller actually skipped, which on a past date it
        // never schedules at all.
        if (this.addTaskWorksDirty) {
            this.addTaskWorksDirty = false;
            this.fetchTasks({ background: true }).catch((error) => console.error(error));
            return;
        }
        this.resumeRefresh();
    }

    async submitAddTask() {
        const clientId = parseInt(this.addTaskClient.value, 10);
        if (Number.isNaN(clientId)) {
            this.showToast('Please select a client', 'error');
            return;
        }
        if (!this.addTaskStart.value || !this.addTaskEnd.value) {
            this.showToast('Please choose a start and end time', 'error');
            return;
        }

        this.addTaskSave.disabled = true;
        try {
            // Raw fetch rather than fetchFromAPI: the 409 carries a body that
            // has to be read to know it's a confirmation rather than a refusal,
            // and fetchFromAPI surfaces only the message. Same reason
            // handleTaskUpdate reads `conflict` directly.
            const response = await fetch('/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    date: this.selectedDate.value,
                    client_id: clientId,
                    start_time: serializeClockTime(this.addTaskStart.value),
                    end_time: serializeClockTime(this.addTaskEnd.value),
                    stretch_day: this.addTaskStretchConfirmed,
                }),
            });
            const data = await response.json();

            if (response.status === 409 && data.needs_confirmation) {
                this.addTaskStretchConfirmed = true;
                setText(this.addTaskWarning, data.error);
                this.addTaskWarning.classList.remove('hidden');
                this.addTaskSave.textContent = 'Add and extend day';
                return;
            }

            if (!response.ok) {
                if (data.conflict?.start_time && data.conflict?.end_time) {
                    throw new Error(
                        `That overlaps an existing task (${formatClockTime(data.conflict.start_time)}–${formatClockTime(data.conflict.end_time)}).`
                    );
                }
                throw new Error(data.error || 'Could not add the task');
            }

            this.closeAddTaskModal();
            this.showToast('Task added');
            await this.fetchTasks();
        } catch (error) {
            // The dialog stays open with the values intact so the times can be
            // corrected against the conflict the message just named.
            this.showToast(error.message, 'error');
        } finally {
            this.addTaskSave.disabled = false;
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
        document.querySelectorAll('#tasks-tbody .tk-row-editing').forEach(editingRow => {
            if (editingRow !== row) this.disableEditMode(editingRow);
        });

        row.classList.add('tk-row-editing');
        row.querySelectorAll('.time-display').forEach(span => span.classList.add('hidden'));
        row.querySelectorAll('.task-time-picker').forEach(input => input.classList.remove('hidden'));
        row.querySelector('.task-view-actions').classList.add('hidden');
        row.querySelector('.edit-controls').classList.remove('hidden');
        row.querySelector('.start-time')?.focus();
    }

    disableEditMode(row) {
        row.classList.remove('tk-row-editing');
        row.querySelectorAll('.time-display').forEach(span => span.classList.remove('hidden'));
        row.querySelectorAll('.task-time-picker').forEach(input => input.classList.add('hidden'));
        row.querySelector('.task-view-actions').classList.remove('hidden');
        row.querySelector('.edit-controls').classList.add('hidden');

        // The row was skipped by every refresh while it was being edited, so
        // its figures may be a few minutes stale. Collect the deferred tick.
        this.resumeRefresh();
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
                    start_time: serializeClockTime(startTime),
                    end_time: serializeClockTime(endTime),
                    client_id: clientId
                })
            });

            const data = await response.json();

            if (!response.ok) {
                if (data.conflict?.start_time && data.conflict?.end_time) {
                    throw new Error(
                        `Task times overlap with an existing task (${formatClockTime(data.conflict.start_time)}–${formatClockTime(data.conflict.end_time)}). Please choose a different time.`
                    )
                }
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

    /**
     * @param {number|null} selectedClientId
     * @param {object} [options]
     * @param {string} [options.placeholder='REMOVED'] Label for the disabled
     *   leading option, used when nothing is selected. A task row with no
     *   client had its client deleted, which is what "REMOVED" says; the Add
     *   task form has simply not been filled in yet, which is a different
     *   thing and must not read as an error.
     */
    getClientOptions(selectedClientId, { placeholder = 'REMOVED' } = {}) {
        const parts = [];
        if (selectedClientId == null) {
            parts.push(`<option value="" selected disabled>${this.escapeHtml(placeholder)}</option>`);
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
        if (tbody) {
            // Blowing the rows away takes their time inputs with them, and a
            // flatpickr whose input vanishes without being destroyed leaves its
            // calendar node and document listener behind.
            this.destroyRowPickers(tbody);
            const columns = this.roundingEnabled ? 5 : 3;
            tbody.innerHTML = `<tr><td colspan="${columns}">${html}</td></tr>`;
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

            // If no start time, we can't calculate day duration
            if (!start_time) {
                return 0;
            }

            // A day in progress is measured up to now. A past day without an
            // end time has no measurable length at all: it used to be assumed
            // to run to 23:59:59, which turned one forgotten click into a
            // fifteen-hour day and dropped that day's utilisation to near zero.
            // The startup sweep (day_close.js) now closes past days at their
            // last task's end, so this branch is only reached if that hasn't
            // run yet — and reporting nothing is better than reporting a
            // figure that is wrong by hours.
            let effectiveEndTime;
            if (!end_time) {
                if (this.selectedDate.value !== this.getLocalDateString()) return 0;
                const now = new Date();
                effectiveEndTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
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

    /**
     * @param {object}  [options]
     * @param {boolean} [options.background=false] A refresh nobody asked for.
     *   Background loads never show a placeholder: the data is already on
     *   screen and still broadly true, so blanking the table to a spinner every
     *   minute reports "working" about a request the user didn't make and
     *   costs them the view. A cold load or a date change has nothing to show
     *   yet and keeps its spinner.
     */
    fetchTasks({ background = false } = {}) {
        // Previously a concurrent call was dropped on the floor, so a date
        // change or the 60s refresh landing mid-load was simply lost. Share the
        // in-flight promise instead so every caller settles.
        //
        // A foreground caller joining a background load is fine: the reconciler
        // makes the outcome identical, only the placeholder differs.
        if (this.loadPromise) return this.loadPromise;

        this.isLoading = true;
        this.loadPromise = this.#loadTasks({ background }).finally(() => {
            this.isLoading = false;
            this.loadPromise = null;
        });

        return this.loadPromise;
    }

    async #loadTasks({ background = false } = {}) {
        const date = this.selectedDate.value;
        const timelineContainer = document.getElementById('timeline');

        // Nothing is torn down on a background pass. renderTimeline reuses the
        // existing timeline, so destroying it here would throw away the user's
        // zoom and pan for no reason.
        if (!background) {
            if (this.timeline) {
                this.timeline.destroy();
                this.timeline = null;
                this.timelineItems = null;
            }
            if (timelineContainer) {
                timelineContainer.setAttribute('aria-busy', 'true');
                timelineContainer.innerHTML = `
                    <div class="tk-loading tk-timeline-loading" role="status">
                        <span class="tk-spinner" aria-hidden="true"></span>
                        <span>Loading timeline&hellip;</span>
                    </div>
                `;
            }

            this.showTasksMessage('<div class="tk-loading"><span class="tk-spinner"></span> Loading tasks…</div>');
        }

        try {
            // Always fetch and populate day data first
            await this.populateDayTimes();

            const response = await this.fetchFromAPI(`/tasks/${date}`);
            await this.renderTasks(response);
            this.renderTimeline(response, date, { background });

            // Recovered — drop any queued retry.
            clearTimeout(this.reloadTimer);
        } catch (error) {
            console.error('Error fetching tasks:', error);

            // A failed background refresh leaves the last good view up. The
            // data on screen is a minute old, which is a far better answer than
            // replacing it with an error for a request the user never made.
            if (background) {
                this.scheduleReload(3000, { background: true });
                return;
            }

            // Say what's happening rather than leaving a bare spinner, then keep
            // trying on our own. The backend is local, so there's no reason to
            // make the user click anything — it'll come back when it comes back.
            this.showTasksMessage(
                '<div class="tk-empty"><span class="tk-spinner"></span>'
                + '<span class="ml-2">Can\'t reach the server. Reconnecting…</span></div>'
            );

            const timeline = document.getElementById('timeline');
            if (timeline) {
                timeline.innerHTML = '';
                timeline.removeAttribute('aria-busy');
            }

            this.scheduleReload();
        }
    }

    /**
     * Keep retrying a failed load in the background, indefinitely.
     *
     * The retry inherits the mode of the load that failed. A background refresh
     * that failed must not come back as a foreground one, or the spinner it was
     * careful not to show appears three seconds later anyway.
     */
    scheduleReload(delay = 3000, { background = false } = {}) {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.fetchTasks({ background }), delay);
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
                this.originalStartTime = serializeClockTime(start_time);
                this.dayStartTimePicker.setDate(clockTimeToDate(this.originalStartTime), false);
            } else {
                this.dayStartTime.value = '';
                this.originalStartTime = '';
                this.dayStartTimePicker.clear();
            }

            if (end_time) {
                this.originalEndTime = serializeClockTime(end_time);
                this.dayEndTimePicker.setDate(clockTimeToDate(this.originalEndTime), false);
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
        } catch (error) {
            console.error('Error populating day times:', error);
            this.dayStartTime.value = '';
            this.dayEndTime.value = '';
            this.originalStartTime = '';
            this.originalEndTime = '';
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

    // formatTimeWithDifference and getMinuteDifference now live on TimeKeeper
    // in base.js — the Today page shows the same figure for the running
    // client and the two must not drift.

    /**
     * Draw the client table.
     *
     * Rows are reconciled against what's on screen rather than rebuilt, because
     * this runs every minute underneath whatever the user is doing. See
     * `reconcileChildren` in base.js for why that distinction matters; the
     * short version is that the fold state of a detail row, a row in edit mode
     * and its unsaved input all live in the DOM and nowhere else.
     */
    async renderTasks(tasks) {
        const tbody = document.getElementById('tasks-tbody');

        // First fetch all clients for the dropdown. This used to be a bare
        // .then() with no .catch(): a failure here cleared the table and then
        // rejected into nothing, leaving a permanently blank page.
        const clients = await this.fetchFromAPI('/clients');
        this.clients = clients;

        const clientGroups = this.aggregateByClient(tasks);
        let totalMinutesForAll = 0;
        let totalFractionalHours = 0;

        if (clientGroups.length === 0) {
            this.destroyRowPickers(tbody);
            tbody.innerHTML = `
                <tr>
                    <td colspan="${this.roundingEnabled ? 5 : 3}" class="tk-empty">No time tracked on this date.</td>
                </tr>
            `;
            // Still update summary values even with no tasks
            this.updateSummaryValues(0, 0);
            return;
        }

        // Row click handlers close over the client, and on a refresh the client
        // objects are rebuilt while the rows are not. Looking the current one
        // up by key at click time keeps a surviving row's Works button pointed
        // at fresh data instead of the aggregate it was born with.
        this.clientsByKey = new Map(clientGroups.map((c) => [c.detailKey, c]));

        for (const client of clientGroups) {
            const totalMinutes = this.totalNumberofMinutesPerClient(client.tasks);
            totalMinutesForAll += totalMinutes;
            totalFractionalHours += this.totalTimeSpentToFractionalHours(totalMinutes);
        }

        reconcileChildren(tbody, clientGroups, {
            key: (client) => client.detailKey,
            create: (client) => [this.createSummaryRow(client), this.createDetailRow(client)],
            update: ([summaryRow, detailRow], client) => {
                this.updateSummaryRow(summaryRow, client);
                this.updateDetailRow(detailRow, client);
            },
            // flatpickr attaches an instance per time input and holds a
            // document-level listener; dropping the row without this leaks one
            // per task per refresh.
            remove: (els) => els.forEach((el) => this.destroyRowPickers(el)),
        });

        this.updateSummaryValues(totalMinutesForAll, totalFractionalHours);
    }

    /** Per-client totals, derived identically for create and update. */
    summaryFigures(client) {
        const totalMinutes = this.totalNumberofMinutesPerClient(client.tasks);
        const fractionalHours = this.totalTimeSpentToFractionalHours(totalMinutes);
        return {
            totalMinutes,
            fractionalHours,
            roundingDiff: Math.round(fractionalHours * 60 - totalMinutes),
        };
    }

    createSummaryRow(client) {
        const summaryRow = document.createElement('tr');
        summaryRow.className = 'task-row';
        summaryRow.dataset.clientKey = client.detailKey;

        // Cells carry `data-cell` so updateSummaryRow can find the two that
        // hold figures without depending on column order, which changes with
        // the rounding setting.
        summaryRow.innerHTML = `
            <td class="font-medium">
                <span class="inline-flex items-center gap-2">
                    <svg class="tk-chevron h-3.5 w-3.5 flex-shrink-0 text-faint transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                    <span data-cell="name">${this.escapeHtml(client.name)}</span>
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
            <td class="tk-num whitespace-nowrap text-muted" data-cell="minutes"></td>
            ${this.roundingEnabled ? `
                <td class="tk-num whitespace-nowrap font-semibold" data-cell="hours"></td>
                <td class="tk-num" data-cell="diff"></td>
            ` : ''}
        `;

        summaryRow.addEventListener('click', (e) => {
            // Resolve through the key, not the captured client — see the note
            // on clientsByKey in renderTasks.
            const current = this.clientsByKey?.get(summaryRow.dataset.clientKey) ?? client;

            // The works buttons sit inside the row, which is itself the
            // fold/unfold target — so they have to swallow their own clicks.
            if (e.target.closest('.works-open-btn')) {
                e.stopPropagation();
                this.openWorksModal(current);
                return;
            }
            if (e.target.closest('.works-copy-btn')) {
                e.stopPropagation();
                this.copyWorks(current);
                return;
            }
            this.toggleDetailTable(current.detailKey);
        });

        this.updateSummaryRow(summaryRow, client);
        return summaryRow;
    }

    /**
     * Patch the figures on an existing summary row.
     *
     * Deliberately does not touch the chevron or the action buttons: the
     * chevron carries an inline rotation set by toggleDetailTable, and whether
     * the buttons exist depends on `client.id == null`, which can't change for
     * a given key because the key is derived from the client id.
     */
    updateSummaryRow(summaryRow, client) {
        const { totalMinutes, fractionalHours, roundingDiff } = this.summaryFigures(client);

        setText(summaryRow.querySelector('[data-cell="name"]'), client.name);
        setText(
            summaryRow.querySelector('[data-cell="minutes"]'),
            this.formatDurationMinutes(totalMinutes)
        );

        const hoursCell = summaryRow.querySelector('[data-cell="hours"]');
        if (hoursCell) {
            setHtml(
                hoursCell,
                `${this.formatDecimalHours(fractionalHours)} <span class="font-normal text-faint">hrs.</span>`
            );
        }

        const diffCell = summaryRow.querySelector('[data-cell="diff"]');
        if (diffCell) {
            diffCell.className = `tk-num ${roundingDiff === 0 ? 'text-faint' : roundingDiff > 0 ? 'text-success' : 'text-danger'}`;
            setText(
                diffCell,
                roundingDiff === 0
                    ? '—'
                    : (roundingDiff > 0 ? '+' : '−') + Math.abs(roundingDiff) + 'm'
            );
        }
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
        // `hidden` is the fold state, and it is the only record of it. A
        // refresh must never rebuild this row for that reason alone.
        detailRow.className = 'detail-row hidden';

        const detailCell = document.createElement('td');
        detailCell.colSpan = this.roundingEnabled ? 5 : 3;
        detailCell.className = 'p-0';

        const detailTable = document.createElement('table');
        detailTable.className = 'tk-table tk-table-nested tk-table-hover tk-task-table';
        detailTable.innerHTML = `
            <colgroup>
                <col class="tk-task-time-column">
                <col class="tk-task-time-column">
                <col class="tk-task-duration-column">
                <col class="tk-task-actions-column">
            </colgroup>
            <thead>
                <tr>
                    <th class="tk-task-time-heading">Start</th>
                    <th class="tk-task-time-heading">End</th>
                    <th class="tk-num">Duration</th>
                    <th class="tk-task-actions-heading"><span class="sr-only">Actions</span></th>
                </tr>
            </thead>
            <tbody></tbody>
        `;

        detailCell.appendChild(detailTable);
        detailRow.appendChild(detailCell);

        this.updateDetailRow(detailRow, client);
        return detailRow;
    }

    /**
     * Reconcile one client's task rows.
     *
     * A row in `tk-row-editing` is skipped outright. Patching it would fight
     * the user for the input they are typing into, and the row's own save path
     * refreshes the table anyway — so the correct move is to leave it alone
     * until they're done. (The poller's `shouldSkip` normally prevents a
     * background refresh from reaching here at all while an edit is open; this
     * is the guarantee for the refreshes that aren't background, like the one
     * that follows saving a *different* row.)
     */
    updateDetailRow(detailRow, client) {
        const tbody = detailRow.querySelector('table > tbody');
        if (!tbody) return;

        reconcileChildren(tbody, client.tasks, {
            key: (task) => task.id,
            create: (task) => this.createTaskRow(task),
            update: (els, task) => this.updateTaskRow(els[0], task),
            skip: (els) => els[0].classList.contains('tk-row-editing'),
            remove: (els) => els.forEach((el) => this.destroyRowPickers(el)),
        });
    }

    createTaskRow(task) {
        const row = document.createElement('tr');
        row.dataset.taskId = task.id;
        row.innerHTML = `
            <td class="tk-num tk-task-time-cell whitespace-nowrap">
                <span class="time-display" data-cell="start"></span>
                <input type="text" class="task-time-picker start-time tk-time-input hidden">
            </td>
            <td class="tk-num tk-task-time-cell whitespace-nowrap">
                <span class="time-display" data-cell="end"></span>
                <input type="text" class="task-time-picker end-time tk-time-input hidden">
            </td>
            <td class="tk-num whitespace-nowrap text-muted" data-cell="duration"></td>
            <td class="tk-task-actions-cell">
                <div class="task-view-actions tk-task-view-actions">
                    <button type="button" class="edit-task-btn tk-btn tk-btn-secondary tk-btn-sm">Edit</button>
                    <button type="button" class="delete-task-btn tk-btn tk-btn-danger tk-btn-sm">Delete</button>
                </div>
                <div class="edit-controls tk-task-edit-controls hidden">
                    <label class="tk-task-client-field">
                        <span>Client</span>
                        <select class="client-select tk-select tk-select-sm"></select>
                    </label>
                    <button type="button" class="save-task-btn tk-btn tk-btn-primary tk-btn-sm">Save</button>
                    <button type="button" class="cancel-task-btn tk-btn tk-btn-secondary tk-btn-sm">Cancel</button>
                </div>
            </td>
        `;

        this.updateTaskRow(row, task);

        // Was a setTimeout(0) per render, which built a fresh flatpickr for
        // every task every minute and abandoned the previous one. Rows now
        // persist, so pickers are built once here and destroyed in
        // destroyRowPickers when the row actually goes away.
        row.querySelectorAll('.task-time-picker').forEach((input) => {
            const picker = flatpickr(input, flatpickrTimeOptions({ minuteIncrement: 1 }));
            if (input.dataset.clockValue) {
                picker.setDate(clockTimeToDate(input.dataset.clockValue), false);
            }
        });

        return row;
    }

    /** Patch a task row's displayed values. Never called on a row being edited. */
    updateTaskRow(row, task) {
        row.classList.toggle('tk-row-ongoing', Boolean(task.is_ongoing));

        const startClock = serializeClockTime(task.start_time);
        const endClock = task.end_time ? serializeClockTime(task.end_time) : '';

        const startCell = row.querySelector('[data-cell="start"]');
        startCell.dataset.clockTime = startClock;
        setText(startCell, formatClockTime(task.start_time));

        // The ongoing badge lives inside the end cell, so this one is markup.
        setHtml(
            row.querySelector('[data-cell="end"]'),
            task.is_ongoing
                ? `<span data-clock-time="${endClock}">${formatClockTime(task.end_time)}</span> <span class="tk-badge tk-badge-warn ml-1.5">Ongoing</span>`
                : `<span data-clock-time="${endClock}">${formatClockTime(task.end_time)}</span>`
        );

        setText(
            row.querySelector('[data-cell="duration"]'),
            `${this.getMinuteDifference(task.end_time, task.start_time)}m`
        );

        // Keep the hidden pickers in step with the values they'd open on. An
        // ongoing task's end time moves every minute, and without this an Edit
        // click a while after load would open on whatever it was at load time.
        const startInput = row.querySelector('.start-time');
        const endInput = row.querySelector('.end-time');
        this.syncPickerValue(startInput, startClock);
        this.syncPickerValue(endInput, endClock);

        const select = row.querySelector('.client-select');
        if (select) setHtml(select, this.getClientOptions(task.client_id));
    }

    /** Point a hidden time input and its flatpickr at a new value. */
    syncPickerValue(input, clockValue) {
        if (!input) return;
        input.dataset.clockValue = clockValue;
        if (!clockValue) return;
        const picker = input._flatpickr;
        if (picker) picker.setDate(clockTimeToDate(clockValue), false);
    }

    /**
     * Destroy flatpickr instances inside an element that is about to be
     * dropped. flatpickr keeps a document-level listener and a detached
     * calendar node per instance, so a row removed without this leaks both.
     */
    destroyRowPickers(element) {
        if (!element) return;
        element.querySelectorAll('.task-time-picker').forEach((input) => {
            input._flatpickr?.destroy();
        });
    }

    toggleDetailTable(clientId) {
        const detailRow = document.getElementById(`detail-row-${clientId}`);
        const expanded = detailRow.classList.toggle('hidden') === false;

        // The summary row immediately precedes its detail row.
        const chevron = detailRow.previousElementSibling?.querySelector('.tk-chevron');
        if (chevron) chevron.style.transform = expanded ? 'rotate(90deg)' : '';
    }

    getLocalDateString() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }


    totalNumberofMinutesPerClient(tasks) {
        return tasks.reduce((total, task) => {
            const endTime = task.end_time || currentClockTime({ includeSeconds: true })
            return total + this.getMinuteDifference(endTime, task.start_time)
        }, 0);
    }

    initializeTimePicker() {
        this.timePicker = flatpickr(this.selectedDate, flatpickrCalendarOptions({
            enableTime: false,
            dateFormat: "Y-m-d",
            defaultDate: new Date(),
            onChange: () => this.fetchTasks()
        }));
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


    renderTimeline(tasks, selectedDate, { background = false } = {}) {
        const container = document.getElementById('timeline');

        // Colour comes from clientColor() in base.js, keyed on the client's
        // name, so a client is the same colour here and on the Summary charts.
        // This used to be a hardcoded stock-palette array indexed by position,
        // which meant the colours disagreed between the two pages and ignored
        // the theme entirely.
        //
        // Generated background and foreground colours stay paired inline.
        // Touching tasks for one client become a single visual range; all other
        // tasks share the same track because the API rejects overlaps.
        const sortedTasks = [...tasks].sort((a, b) =>
            this.timeStringToMinutes(a.start_time) - this.timeStringToMinutes(b.start_time)
        );
        const timelineTasks = mergeAdjacentClientTasks(sortedTasks);
        const items = timelineTasks.map(task => {
            const startLabel = formatClockTime(task.start_time);
            const endLabel = formatClockTime(task.end_time);
            const durationMinutes = this.getMinuteDifference(task.end_time, task.start_time);
            const durationLabel = this.formatDurationMinutes(durationMinutes);
            const clientName = this.escapeHtml(task.client_name);

            return {
                id: task.id,
                className: task.is_ongoing ? 'tk-timeline-range is-ongoing' : 'tk-timeline-range',
                content: `
                    <span class="tk-timeline-item">
                        <span class="tk-timeline-item-client">${clientName}</span>
                    </span>
                `,
                title: `
                    <div class="tk-timeline-tooltip">
                        <strong>${clientName}</strong>
                        <span>${startLabel}–${endLabel}</span>
                        <span>${durationLabel}${task.is_ongoing ? ' · Ongoing' : ''}</span>
                    </div>
                `,
                start: `${selectedDate}T${task.start_time}`,
                end: `${selectedDate}T${task.end_time}`,
                style: `background-color: ${clientColor(task.client_name)}; color: ${clientForeground(task.client_name)};`
            };
        });

        // A live timeline for the same day is updated through its DataSet
        // rather than replaced. `new vis.Timeline(...)` recomputes the visible
        // window from `options.start`/`end`, so rebuilding it every minute
        // silently undid any zoom or pan the user had applied — and the
        // rebuild is also what made the whole strip flash.
        const reusable = background
            && this.timeline
            && this.timelineItems
            && this.timelineDate === selectedDate;

        if (reusable) {
            this.updateTimelineItems(items);
            this.updateTimelineBoundaries(selectedDate);
            this.renderTimelineSummary(sortedTasks);
            return this.timeline;
        }

        this.renderTimelineSummary(sortedTasks);

        // Falling through to a full build with a live timeline still mounted
        // would leave two of them in the container. The foreground path clears
        // this already; this covers the background pass that can't reuse —
        // a date change racing a tick, or a rebuild after a failed load.
        if (this.timeline) {
            this.timeline.destroy();
            this.timeline = null;
            this.timelineItems = null;
        }

        // Keep an eight-hour minimum for useful context, but expand and center
        // the window around the day's tasks and its start/close boundaries. A
        // boundary must remain visible even when it falls before the first task
        // or after the last one.
        const now = new Date();
        const today = this.getLocalDateString();
        const isSelectedDateToday = selectedDate === today;
        const minimumViewMinutes = 8 * 60;
        const boundaryMinutes = [this.originalStartTime, this.originalEndTime]
            .filter(Boolean)
            .map(time => this.timeStringToMinutes(time));
        const occupiedPoints = [
            ...sortedTasks.flatMap(task => [
                this.timeStringToMinutes(task.start_time),
                this.timeStringToMinutes(task.end_time),
            ]),
            ...boundaryMinutes,
        ];
        let viewStartMinutes;
        let viewEndMinutes;

        if (occupiedPoints.length > 0) {
            const earliestStart = Math.min(...occupiedPoints);
            const latestEnd = Math.max(...occupiedPoints);
            const occupiedMinutes = Math.max(1, latestEnd - earliestStart);
            const viewMinutes = Math.min(24 * 60 - 1, Math.max(minimumViewMinutes, occupiedMinutes + 60));
            const centerMinutes = (earliestStart + latestEnd) / 2;
            viewStartMinutes = Math.max(0, Math.min(24 * 60 - 1 - viewMinutes, centerMinutes - viewMinutes / 2));
            viewEndMinutes = viewStartMinutes + viewMinutes;
        } else {
            const centerMinutes = isSelectedDateToday
                ? now.getHours() * 60 + now.getMinutes()
                : 12 * 60;
            viewStartMinutes = Math.max(0, Math.min(24 * 60 - 1 - minimumViewMinutes, centerMinutes - minimumViewMinutes / 2));
            viewEndMinutes = viewStartMinutes + minimumViewMinutes;
        }

        const dateTimeAtMinute = (minutes) => {
            const boundedMinutes = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
            const hours = String(Math.floor(boundedMinutes / 60)).padStart(2, '0');
            const mins = String(boundedMinutes % 60).padStart(2, '0');
            return `${selectedDate}T${hours}:${mins}:00`;
        };

        const startTime = dateTimeAtMinute(viewStartMinutes);
        const endTime = dateTimeAtMinute(viewEndMinutes);

        const options = {
            start: startTime,
            end: endTime,
            orientation: 'top',
            stack: false,
            verticalScroll: false,
            zoomKey: 'ctrlKey',
            height: '132px',
            margin: {
                axis: 10,
                item: { horizontal: 2, vertical: 12 },
            },
            showCurrentTime: isSelectedDateToday,
            zoomMin: 30 * 60 * 1000,
            zoomMax: 24 * 60 * 60 * 1000,
            min: `${selectedDate}T00:00:00`,
            max: `${selectedDate}T23:59:59`,
            format: visTimelineTimeFormat(),
            tooltip: {
                followMouse: true,
                overflowMethod: 'cap',
            },
            onInitialDrawComplete: () => {
                // vis-timeline fires this after its redraw loop has finished.
                // Removing the overlay in the next frame keeps the spinner up
                // until the completed timeline is ready for the same paint.
                requestAnimationFrame(() => {
                    container.querySelector('.tk-timeline-loading')?.remove();
                    container.removeAttribute('aria-busy');
                });
            },
        };

        // The loader is an overlay, so vis-timeline can build underneath it.
        // onInitialDrawComplete removes it only after the first full redraw.
        const dataSet = new vis.DataSet(items);
        const timeline = new vis.Timeline(container, dataSet, options);

        const addDayBoundary = (clockTime, id, label) => {
            if (!clockTime) return;

            const formattedTime = formatClockTime(clockTime);
            timeline.addCustomTime(`${selectedDate}T${clockTime}`, id);
            timeline.setCustomTimeTitle(`${label}: ${formattedTime}`, id);
        };

        addDayBoundary(this.originalStartTime, 'tk-day-start', 'Start');
        addDayBoundary(this.originalEndTime, 'tk-day-close', 'Close');

        this.timeline = timeline
        this.timelineItems = dataSet;
        this.timelineDate = selectedDate;
        this.timelineBoundaries = new Map([
            ['tk-day-start', this.originalStartTime || null],
            ['tk-day-close', this.originalEndTime || null],
        ]);
        return timeline;
    }

    /** One line of context under the timeline. */
    renderTimelineSummary(sortedTasks) {
        const summary = document.getElementById('timeline-summary');
        if (!summary) return;

        const taskCount = sortedTasks.length;
        if (taskCount === 0) {
            setText(summary, 'No tracked tasks');
            return;
        }

        const totalMinutes = sortedTasks.reduce(
            (total, task) => total + this.getMinuteDifference(task.end_time, task.start_time),
            0
        );
        const firstStart = formatClockTime(sortedTasks[0].start_time);
        const lastEnd = formatClockTime(sortedTasks[sortedTasks.length - 1].end_time);
        setText(
            summary,
            `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'} · ${this.formatDurationMinutes(totalMinutes)} · ${firstStart}–${lastEnd}`
        );
    }

    /**
     * Diff a fresh item list into the live DataSet.
     *
     * vis redraws only what the DataSet reports as changed, so an unchanged
     * range keeps its DOM node — and with it any tooltip the user is hovering.
     * Wholesale `clear()` + `add()` would redraw every range on every tick.
     */
    updateTimelineItems(items) {
        const wanted = new Set(items.map((item) => item.id));
        const stale = this.timelineItems.getIds().filter((id) => !wanted.has(id));
        if (stale.length) this.timelineItems.remove(stale);
        this.timelineItems.update(items);
    }

    /**
     * Move the day start/close markers to their current values.
     *
     * vis throws on setCustomTime for an id it doesn't know and on
     * addCustomTime for one it does, so the ids in play are tracked rather
     * than probed.
     */
    updateTimelineBoundaries(selectedDate) {
        const wanted = new Map([
            ['tk-day-start', { time: this.originalStartTime || null, label: 'Start' }],
            ['tk-day-close', { time: this.originalEndTime || null, label: 'Close' }],
        ]);

        for (const [id, { time, label }] of wanted) {
            const present = this.timelineBoundaries.get(id);

            if (!time) {
                if (present) {
                    this.timeline.removeCustomTime(id);
                    this.timelineBoundaries.set(id, null);
                }
                continue;
            }

            if (present) {
                this.timeline.setCustomTime(`${selectedDate}T${time}`, id);
            } else {
                this.timeline.addCustomTime(`${selectedDate}T${time}`, id);
            }
            this.timeline.setCustomTimeTitle(`${label}: ${formatClockTime(time)}`, id);
            this.timelineBoundaries.set(id, time);
        }
    }



}

ready(() => {
    new TaskBrowser();
});
