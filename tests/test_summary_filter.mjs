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
dashboard.calendar = { load() { calendarLoads++ } }
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

console.log('summary client filter scopes both dashboard reads')
