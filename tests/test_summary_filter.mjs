import assert from 'node:assert/strict'

const stubElement = () => ({
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    value: '',
    addEventListener() {},
    appendChild() {},
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
})

globalThis.document = {
    readyState: 'loading',
    documentElement: stubElement(),
    body: stubElement(),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => stubElement(),
    createElement: () => stubElement(),
}
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) }

const { SummaryDashboard } = await import('../static/js/summary.js')

const dashboard = Object.create(SummaryDashboard.prototype)
dashboard.clientFilter = { value: '' }
dashboard.clientFilterClear = { hidden: true }
dashboard.clientFilterValue = ''
dashboard.clientFilterPicker = {
    setChoiceByValue(value) { dashboard.clientFilter.value = value },
    removeActiveItems() { dashboard.clientFilter.value = '' },
}

let calendarLoads = 0
let overviewLoads = 0
let selectedCalendarRange = null
dashboard.calendar = {
    lastComplete: '2026-08-13',
    load() { calendarLoads++ },
    setRange(start, end) { selectedCalendarRange = [start, end] },
}
dashboard.refresh = () => { overviewLoads++ }

dashboard.selectClient(42)
assert.equal(dashboard.clientFilter.value, '42')
assert.equal(dashboard.clientFilterClear.hidden, false)
assert.deepEqual([calendarLoads, overviewLoads], [1, 1])

dashboard.selectClient(42)
assert.deepEqual([calendarLoads, overviewLoads], [1, 1])

assert.equal(
    dashboard.summaryParams('2026-08-01', '2026-08-07', [0, 3]).toString(),
    'start=2026-08-01&end=2026-08-07&weekdays=0%2C3&client_id=42',
)

dashboard.clearClientFilter()
assert.equal(dashboard.clientFilterClear.hidden, true)
assert.deepEqual([calendarLoads, overviewLoads], [2, 2])
assert.equal(
    dashboard.summaryParams('2026-08-01', '2026-08-07').toString(),
    'start=2026-08-01&end=2026-08-07',
)

let rangeOptions = null
const rangePicker = {
    dateSets: [],
    setDate(value, trigger) { this.dateSets.push([value, trigger]) },
    jumpToDate() {},
}
globalThis.flatpickr = (_input, options) => {
    rangeOptions = options
    return rangePicker
}
dashboard.rangeInput = stubElement()
dashboard.initializeDateRangePicker()

assert.equal(rangeOptions.mode, 'range')
assert.equal(rangeOptions.dateFormat, 'Y-m-d')
assert.equal(rangeOptions.altInput, true)
assert.equal(rangeOptions.altFormat, 'M j, Y')
assert.equal(rangeOptions.locale.rangeSeparator, ' – ')
assert.equal(rangeOptions.showMonths, 2)
assert.equal(rangeOptions.maxDate, '2026-08-13')

rangeOptions.onChange([new Date(2026, 7, 4), new Date(2026, 7, 8)])
assert.deepEqual(selectedCalendarRange, ['2026-08-04', '2026-08-08'])

rangeOptions.onClose([new Date(2026, 7, 6)])
assert.deepEqual(selectedCalendarRange, ['2026-08-06', '2026-08-06'])

dashboard.renderSelectionHeader = () => {}
dashboard.markActivePreset = () => {}
dashboard.selectRange({ start: '2026-08-03', end: '2026-08-07', weekdays: null })
assert.deepEqual(rangePicker.dateSets.at(-1), [['2026-08-03', '2026-08-07'], false])

let sticky = false
const stickyProperties = {}
let resizeCallback = null
let intersectionCallback = null
const sentinel = {}
const page = { style: { setProperty(name, value) { stickyProperties[name] = value } } }
const scrollRoot = { getBoundingClientRect: () => ({ top: 88 }) }
dashboard.viewBar = {
    offsetHeight: 70,
    closest: () => page,
    classList: { toggle(_name, value) { sticky = value } },
}
dashboard.viewSentinel = sentinel
document.querySelector = (selector) => selector === 'main' ? scrollRoot : null
globalThis.ResizeObserver = window.ResizeObserver = class {
    constructor(callback) { resizeCallback = callback }
    observe(target) { assert.equal(target, dashboard.viewBar) }
}
globalThis.IntersectionObserver = window.IntersectionObserver = class {
    constructor(callback) { intersectionCallback = callback }
    observe(target) { assert.equal(target, sentinel) }
}

dashboard.initializeStickyView()
assert.equal(stickyProperties['--summary-view-docked-height'], '70px')
assert.equal(stickyProperties['--summary-view-sticky-offset'], 'calc(70px + 1rem)')
dashboard.viewBar.offsetHeight = 82
resizeCallback()
assert.equal(stickyProperties['--summary-view-docked-height'], '82px')
assert.equal(stickyProperties['--summary-view-sticky-offset'], 'calc(82px + 1rem)')

intersectionCallback([{
    isIntersecting: false,
    boundingClientRect: { bottom: 87 },
    rootBounds: { top: 88 },
}])
assert.equal(sticky, true)
intersectionCallback([{
    isIntersecting: true,
    boundingClientRect: { bottom: 120 },
    rootBounds: { top: 88 },
}])
assert.equal(sticky, false)

console.log('summary view controls keep client and date filters in sync')
