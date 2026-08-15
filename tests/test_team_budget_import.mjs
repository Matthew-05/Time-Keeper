import assert from 'node:assert/strict'

globalThis.document = {
    readyState: 'loading',
    documentElement: { dataset: {} },
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
}
globalThis.window = {
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
}

const {
    importChoiceErrors,
    teamBudgetDetailScope,
    teamBudgetMatchesFilter,
    TEAM_STATUS_LABEL,
} = await import(
    '../static/js/team_budgets.js'
)
const { detailDateRange } = await import('../static/js/budget_render.js')

const preview = {
    row_count: 12,
    validation_error_count: 0,
    unknown_user_ids: ['new-user', 'alias-user'],
    out_of_range_row_count: 2,
}

assert.deepEqual(
    importChoiceErrors(preview, {}, ''),
    [
        'Choose where new-user belongs.',
        'Choose where alias-user belongs.',
        'Choose how to handle dates outside the budget period.',
    ],
)

assert.deepEqual(
    importChoiceErrors(
        preview,
        {
            'new-user': { action: 'new', display_name: 'Ada', budgeted_hours: 40 },
            'alias-user': { action: 'existing', member_id: 7 },
        },
        'adjust',
    ),
    [],
)

assert.deepEqual(
    importChoiceErrors(
        { ...preview, validation_error_count: 3 },
        {
            'new-user': { action: 'new', budgeted_hours: 0 },
            'alias-user': { action: 'existing', member_id: null },
        },
        'skip',
    ),
    [
        'Fix invalid workbook rows first.',
        'Enter budgeted hours for new-user.',
        'Choose an existing member for alias-user.',
    ],
)

assert.equal(TEAM_STATUS_LABEL.at_risk, 'At risk')
assert.equal(teamBudgetMatchesFilter({ is_closed: false }, 'active'), true)
assert.equal(teamBudgetMatchesFilter({ is_closed: true, status: 'over' }, 'closed'), true)
assert.equal(teamBudgetMatchesFilter({ is_closed: true }, 'active'), false)
assert.equal(teamBudgetMatchesFilter({ is_closed: false }, 'all'), true)
const detail = { members: [{ id: 7, name: 'Ada' }, { id: 12, name: 'Grace' }] }
assert.equal(teamBudgetDetailScope(detail, ''), null)
assert.equal(teamBudgetDetailScope(detail, '12').name, 'Grace')
assert.equal(teamBudgetDetailScope(detail, '404'), null)
assert.equal(
    detailDateRange({ start_date: '2026-08-07', end_date: '2027-01-12' }),
    'Aug 7, 2026 – Jan 12, 2027',
)
console.log('team budget import choices require complete mappings and range handling')
