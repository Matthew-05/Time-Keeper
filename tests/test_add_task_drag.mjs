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
    readyState: 'complete',
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

const { TaskBrowser } = await import('../static/js/task_browser.js');

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

let failures = 0;
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

console.log(failures ? `\n${failures} failure(s)` : '\nall drag checks passed');
process.exit(failures ? 1 : 0);
