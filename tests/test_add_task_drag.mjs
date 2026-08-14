/**
 * The Add task timeline's drag arithmetic.
 *
 * `npm run test:js` — plain Node, no runner and no jsdom. The DOM stub below is
 * only there to let the module graph evaluate; nothing here touches it. The
 * methods under test are called on a bare object with `TaskBrowser.prototype`,
 * so this exercises the shipped code rather than a copy of it.
 *
 * Worth the stub because this is the one piece of the dialog that can't be
 * eyeballed. It already had a real bug: anchoring the draft to the gap
 * containing its *midpoint* fails at exactly the moment clamping matters, since
 * a draft dragged onto a wall puts its midpoint on the boundary, and gaps are
 * half-open — so the frame was refused precisely where it needed to be held.
 * The `midpoint lands exactly on the wall` case below is that bug.
 */

const stubElement = () => ({
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    style: {},
    children: [],
    firstElementChild: null,
    value: '',
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
    appendChild() {},
    insertBefore() {},
    querySelector: () => null,
    querySelectorAll: () => [],
});

globalThis.document = {
    // Keep the module's page bootstrap dormant; these checks exercise methods
    // directly and do not provide the complete History DOM.
    readyState: 'loading',
    documentElement: stubElement(),
    body: stubElement(),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => stubElement(),
    createElement: () => stubElement(),
};
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.flatpickr = () => ({ setDate() {}, clear() {}, destroy() {}, selectedDates: [] });
globalThis.vis = {
    DataSet: class { get() { return null; } update() {} remove() {} },
    Timeline: class {},
};

const { dismissOnBackdropClick } = await import('../static/js/base.js');
const { TaskBrowser } = await import('../static/js/task_browser.js');
const { ManualAdjustmentManager } = await import('../static/js/manual_adjustments.js');

let failures = 0;

console.log('modal dismissal requires a full backdrop click');
{
    const listeners = {};
    const backdrop = {
        addEventListener: (type, callback) => { listeners[type] = callback; },
    };
    const panel = {};
    let dismissals = 0;
    dismissOnBackdropClick(backdrop, () => { dismissals++; });

    listeners.click({ target: backdrop });
    check('mouse-up/click alone does not dismiss', dismissals, 0);

    listeners.pointerdown({ target: panel });
    listeners.click({ target: backdrop });
    check('pressing in the dialog then releasing outside does not dismiss', dismissals, 0);

    listeners.pointerdown({ target: backdrop });
    listeners.click({ target: backdrop });
    check('pressing and releasing on the backdrop dismisses', dismissals, 1);
}

/* Recorded: 09:00–10:30 and 14:00–15:00, inside a 09:00–17:00 day. */
const GAPS = [
    { start_time: '10:30', end_time: '14:00' },
    { start_time: '15:00', end_time: '17:00' },
];

const browser = Object.create(TaskBrowser.prototype);
browser.selectedDate = { value: '2026-08-10' };
browser.addTaskDayData = { gaps: GAPS };

let written = null;
browser.setAddTaskTimes = (start, end) => { written = [start, end]; };

/** Run one drag frame. Returns the times it wrote, or null if refused. */
function drag(startClock, endClock) {
    written = null;
    let accepted = null;
    browser.handleDraftMoving(
        {
            id: 'draft',
            start: browser.minutesToDate(browser.clockToMinutes(startClock)),
            end: browser.minutesToDate(browser.clockToMinutes(endClock)),
        },
        (result) => { accepted = result; },
    );
    return accepted === null ? null : written;
}

function check(label, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) {
        failures++;
        console.log(`  FAIL ${label}\n       got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    } else {
        console.log(`  ok   ${label}`);
    }
}

console.log('a draft inside a stretch is left alone');
check('11:00-12:00', drag('11:00', '12:00'), ['11:00', '12:00']);
check('15:30-16:30, second stretch', drag('15:30', '16:30'), ['15:30', '16:30']);

console.log('\nthe body hits a wall: the span is kept, the draft is pushed back');
check('midpoint lands exactly on the wall', drag('12:30', '14:30'), ['12:00', '14:00']);
check('past the left wall', drag('10:00', '11:00'), ['10:30', '11:30']);
check('past the right wall', drag('13:30', '14:30'), ['13:00', '14:00']);
check('past the end of the day', drag('16:30', '17:30'), ['16:00', '17:00']);

console.log('\nan edge resized past a wall stops at it');
check('left edge', drag('09:30', '13:00'), ['10:30', '14:00']);
check('right edge', drag('11:00', '15:30'), ['10:30', '14:00']);

console.log('\na span longer than the stretch is cut to it, largest overlap winning');
check('10:00-18:00', drag('10:00', '18:00'), ['10:30', '14:00']);

console.log('\nno overlap with untracked time refuses the frame');
check('inside the morning task', drag('09:15', '09:45'), null);
check('inside the afternoon task', drag('14:15', '14:45'), null);

console.log('\nsquashed flat, the draft still has walls');
check('zero length grows to the floor', drag('12:00', '12:00'), ['12:00', '12:05']);

console.log('\na stretch narrower than the floor gives a shorter draft, not an overlap');
browser.addTaskDayData = { gaps: [{ start_time: '12:00', end_time: '12:03' }] };
check('three-minute stretch', drag('12:00', '12:00'), ['12:00', '12:03']);
browser.addTaskDayData = { gaps: GAPS };

console.log('\nonly the draft is movable');
{
    let got = 'unset';
    browser.handleDraftMoving(
        { id: 'task-3', start: browser.minutesToDate(540), end: browser.minutesToDate(630) },
        (result) => { got = result; },
    );
    check('a recorded item is refused', got, null);
}

console.log('\ngapAt treats stretches as half-open');
check('the opening instant is inside', browser.gapAt(browser.clockToMinutes('10:30'))?.start_time, '10:30');
check('the closing instant is outside', browser.gapAt(browser.clockToMinutes('14:00')), null);
check('a minute before the close is inside', browser.gapAt(browser.clockToMinutes('13:59'))?.start_time, '10:30');

console.log('\nAdd task stays disabled until both required choices are made');
{
    const save = { disabled: false };
    const form = Object.create(TaskBrowser.prototype);
    form.addTaskSave = save;
    form.addTaskSubmitting = false;
    form.addTaskClient = { value: '' };
    form.addTaskStart = { value: '' };
    form.addTaskEnd = { value: '' };

    check('no client or period', (form.updateAddTaskSaveState(), save.disabled), true);
    form.addTaskClient.value = '4';
    check('client without period', (form.updateAddTaskSaveState(), save.disabled), true);
    form.addTaskStart.value = '09:00';
    form.addTaskEnd.value = '10:00';
    check('client and period', (form.updateAddTaskSaveState(), save.disabled), false);
    form.addTaskEnd.value = '09:00';
    check('empty-length period', (form.updateAddTaskSaveState(), save.disabled), true);
}

console.log('\nHistory date navigation stops at today');
{
    const history = Object.create(TaskBrowser.prototype);
    const dates = [];
    let fetches = 0;
    history.selectedDate = { value: '2026-08-13' };
    history.nextDayBtn = { disabled: false };
    history.getLocalDateString = () => '2026-08-13';
    history.timePicker = { setDate: (value) => dates.push(value) };
    history.fetchTasks = () => { fetches++; };

    const pickerOptions = history.historyDatePickerOptions();
    check(
        'picker starts today with a friendly display date',
        [pickerOptions.defaultDate, pickerOptions.dateFormat, pickerOptions.altInput, pickerOptions.altFormat, pickerOptions.locale.rangeSeparator],
        ['2026-08-13', 'Y-m-d', true, 'l, M j, Y', ' – '],
    );
    history.updateDateNavigation();
    check('next is disabled on today', history.nextDayBtn.disabled, true);
    history.navigateDay(1);
    check('future day is refused', [dates, fetches], [[], 0]);

    history.selectedDate.value = '2026-08-12';
    history.updateDateNavigation();
    check('next is enabled in the past', history.nextDayBtn.disabled, false);
    history.navigateDay(1);
    check('today remains reachable', [dates, fetches], [['2026-08-13'], 1]);
}

console.log('\nHistory keeps an ongoing task open while editing it');
{
    const classes = (...initial) => {
        const values = new Set(initial);
        return {
            add: (...names) => names.forEach((name) => values.add(name)),
            remove: (...names) => names.forEach((name) => values.delete(name)),
            contains: (name) => values.has(name),
            toggle: (name, force) => {
                if (force === undefined ? !values.has(name) : force) values.add(name);
                else values.delete(name);
            },
        };
    };
    const startDisplay = { dataset: { cell: 'start' }, classList: classes(), textContent: '' };
    const endDisplay = { dataset: { cell: 'end' }, classList: classes(), innerHTML: '' };
    const startInput = { dataset: {}, classList: classes('task-time-picker', 'start-time', 'hidden'), value: '09:00', focus() {} };
    const endInput = { dataset: {}, classList: classes('task-time-picker', 'end-time', 'hidden'), disabled: false };
    const viewActions = { classList: classes() };
    const editControls = { classList: classes('hidden') };
    const clientSelect = { value: '4', innerHTML: '' };
    const duration = { textContent: '' };
    const elements = {
        '[data-cell="start"]': startDisplay,
        '[data-cell="end"]': endDisplay,
        '[data-cell="duration"]': duration,
        '.start-time': startInput,
        '.end-time': endInput,
        '.task-view-actions': viewActions,
        '.edit-controls': editControls,
        '.client-select': clientSelect,
    };
    const taskRow = {
        dataset: {},
        classList: classes(),
        querySelector: (selector) => elements[selector] ?? null,
        querySelectorAll: (selector) => selector === '.time-display'
            ? [startDisplay, endDisplay]
            : selector === '.task-time-picker' ? [startInput, endInput] : [],
    };
    const ongoing = Object.create(TaskBrowser.prototype);
    ongoing.clients = [{ id: 4, name: 'Acme' }];
    ongoing.updateTaskRow(taskRow, {
        id: 12,
        start_time: '09:00:00',
        end_time: '10:15:00', // API effective end; not a stored end.
        client_id: 4,
        is_ongoing: true,
    });
    check('end cell is only the pulsing badge', endDisplay.innerHTML,
        '<span class="tk-badge tk-badge-warn"><span class="tk-dot tk-dot-pulse"></span>Ongoing</span>');
    check('ongoing state disables the end picker', endInput.disabled, true);

    ongoing.enableEditMode(taskRow);
    check('edit reveals the start picker', startInput.classList.contains('hidden'), false);
    check('edit leaves the end picker hidden', endInput.classList.contains('hidden'), true);
    check('edit leaves the ongoing badge visible', endDisplay.classList.contains('hidden'), false);

    const originalFetch = globalThis.fetch;
    let submitted = null;
    globalThis.fetch = async (_url, options) => {
        submitted = JSON.parse(options.body);
        return { ok: true, json: async () => ({ success: true }) };
    };
    ongoing.showToast = () => {};
    ongoing.fetchTasks = async () => {};
    ongoing.disableEditMode = () => {};
    await ongoing.handleTaskUpdate(taskRow);
    globalThis.fetch = originalFetch;
    check('save sends only start and client', submitted,
        { start_time: '09:00', client_id: 4 });
}

console.log('\nManual adjustments require a non-zero delta and use hours/minutes');
{
    const manager = Object.create(ManualAdjustmentManager.prototype);
    manager.owner = {
        totalTimeSpentToFractionalHours: (minutes) => minutes / 60,
        formatDurationMinutes: (minutes) => `${minutes}m`,
        formatDecimalHours: (hours) => String(hours),
        roundingEnabled: false,
        roundingIntervalMinutes: 15,
        roundingDirection: 'nearest',
    };
    manager.baseMinutes = 120;
    manager.deltaHours = { value: '0' };
    manager.deltaMinutesField = { value: '0' };
    manager.deltaOperator = stubElement();
    manager.deltaSign = 1;
    manager.totalHours = { value: '' };
    manager.totalMinutes = { value: '' };
    manager.save = { disabled: false };
    const roundingTone = new Set();
    manager.difference = {
        textContent: '',
        classList: {
            add: (...names) => names.forEach(name => roundingTone.add(name)),
            remove: (...names) => names.forEach(name => roundingTone.delete(name)),
        },
    };
    manager.rounded = stubElement();
    const roundedInputTone = new Set();
    manager.roundedHours = {
        value: '',
        step: '',
        classList: {
            add: (...names) => names.forEach(name => roundedInputTone.add(name)),
            remove: (...names) => names.forEach(name => roundedInputTone.delete(name)),
        },
    };
    manager.error = stubElement();
    manager.clientId = () => 1;

    manager.setAdjustedMinutes(135);
    check('135 minutes splits into hour/minute inputs',
        [manager.totalHours.value, manager.totalMinutes.value], ['2', '15']);

    manager.renderResult();
    check('zero adjustment keeps save disabled', manager.save.disabled, true);

    manager.deltaMinutesField.value = '15';
    manager.renderResult();
    check('non-zero adjustment enables save', manager.save.disabled, false);

    manager.totalHours.value = '3';
    manager.totalMinutes.value = '5';
    manager.syncFromTotal();
    check('editing adjusted time recalculates adjustment hours/minutes',
        [manager.deltaHours.value, manager.deltaMinutesField.value], ['1', '5']);

    manager.owner.roundingEnabled = true;
    manager.owner.totalTimeSpentToFractionalHours = (minutes) => (
        Math.floor(minutes / 15 + 0.5) * 15 / 60
    );
    manager.owner.formatDecimalHours = (hours) => Number(hours.toFixed(2)).toString();

    manager.setDeltaMinutes(0);
    manager.setAdjustedMinutes(manager.baseMinutes);
    manager.renderResult();
    check('a new client starts with an explicit zero adjustment',
        [manager.deltaHours.value, manager.deltaMinutesField.value], ['0', '0']);
    check('a zero adjustment still populates the rounded calculation',
        manager.roundedHours.value, '2');
    check('a zero adjustment is calculated but cannot be saved',
        manager.save.disabled, true);

    manager.totalHours.value = '3';
    manager.totalMinutes.value = '5';
    manager.syncFromTotal();
    manager.renderResult();
    check('rounded result is an editable decimal-hours value',
        manager.roundedHours.value, '3');
    check('rounded result shows only a compact signed-minute difference',
        manager.difference.textContent, '−5m');
    check('rounding that removes time is red',
        [roundingTone.has('text-danger'), roundedInputTone.has('text-danger')],
        [true, true]);

    manager.totalHours.value = '3';
    manager.totalMinutes.value = '8';
    manager.syncFromTotal();
    check('rounding that adds time is green',
        [roundingTone.has('text-success'), roundedInputTone.has('text-success')],
        [true, true]);

    manager.roundedHours.value = '1.5';
    check('rounded hours accepts half-hour decimals',
        manager.roundedTargetMinutes(), 90);
    manager.roundedHours.value = '1.25';
    check('rounded hours accepts quarter-hour decimals',
        manager.roundedTargetMinutes(), 75);

    manager.owner.roundingDirection = 'down';
    manager.owner.totalTimeSpentToFractionalHours = (minutes) => (
        Math.floor(minutes / 15) * 15 / 60
    );
    manager.roundedHours.value = '3.2';
    manager.syncFromRounded(true);
    check('rounded-hours entry snaps to the nearest policy interval',
        manager.roundedHours.value, '3.25');
    check('editing rounded hours recalculates adjusted hours/minutes',
        [manager.totalHours.value, manager.totalMinutes.value], ['3', '15']);
    check('editing rounded hours recalculates adjustment hours/minutes',
        [manager.deltaHours.value, manager.deltaMinutesField.value], ['1', '15']);

    const deleteClasses = new Set(['hidden']);
    manager.deleteButton = {
        classList: {
            add: (...names) => names.forEach(name => deleteClasses.add(name)),
            remove: (...names) => names.forEach(name => deleteClasses.delete(name)),
            contains: (name) => deleteClasses.has(name),
            toggle: (name, force) => force
                ? deleteClasses.add(name)
                : deleteClasses.delete(name),
        },
    };
    manager.setDeleteAvailable(true);
    check('existing adjustments expose the form delete action',
        deleteClasses.has('hidden'), false);
    manager.setDeleteAvailable(false);
    check('new adjustments hide the form delete action',
        deleteClasses.has('hidden'), true);

    const restrictedListeners = {};
    const restrictedInteger = {
        value: '2',
        dataset: {},
        addEventListener: (type, callback) => { restrictedListeners[type] = callback; },
    };
    manager.restrictNumberInput(restrictedInteger, { integer: true });
    restrictedListeners.focus();
    let prevented = false;
    restrictedListeners.keydown({ key: '.', preventDefault: () => { prevented = true; } });
    check('integer controls block decimal keystrokes', prevented, true);
    restrictedInteger.value = '-1';
    restrictedListeners.input();
    check('integer controls reject pasted negative values', restrictedInteger.value, '2');
    restrictedInteger.value = '2.5';
    restrictedListeners.input();
    check('integer controls reject pasted fractional values', restrictedInteger.value, '2');

    manager.owner.roundingEnabled = true;
    manager.owner.escapeHtml = (value) => String(value);
    manager.owner.formatDecimalHours = (hours) => Number(hours.toFixed(2)).toString();
    manager.list = { innerHTML: '' };
    manager.adjustments = [{
        id: 8,
        client_name: 'Acme',
        adjustment_minutes: 8,
        adjusted_minutes: 68,
        billable_minutes: 75,
    }];
    manager.renderList();
    check('adjustment rows include rounded hours and a green positive difference', [
        manager.list.innerHTML.includes('1.25'),
        manager.list.innerHTML.includes('+7m'),
        manager.list.innerHTML.includes('text-success'),
    ], [true, true, true]);

    manager.adjustments[0].billable_minutes = 60;
    manager.renderList();
    check('adjustment rows show a red negative rounding difference', [
        manager.list.innerHTML.includes('−8m'),
        manager.list.innerHTML.includes('text-danger'),
    ], [true, true]);

    manager.owner.roundingEnabled = false;
    manager.renderList();
    check('rounded adjustment columns are omitted when rounding is disabled',
        manager.list.innerHTML.includes('hrs.'), false);
    manager.adjustments = [];
    manager.renderList();
    check('empty adjustment rows span only the visible columns',
        manager.list.innerHTML.includes('colspan="4"'), true);
    check('running-task base drops partial minutes',
        manager.normalizedBaseMinutes(65.98, true), 65);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
