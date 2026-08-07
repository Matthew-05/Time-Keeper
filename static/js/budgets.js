import { TimeKeeper, ready, lockBodyScroll, unlockBodyScroll } from './base.js'
import {
    STATUS_LABEL,
    dateRange,
    headline,
    hours,
    meter,
    paceNote,
    percent,
    shortDate,
} from './budget_render.js'

/**
 * Budgets page.
 *
 * Every figure on this page is derived server-side — the client never does
 * allocation arithmetic, because one budget's usage depends on what its
 * overlapping neighbours absorbed and duplicating that rule in two languages is
 * how the two would come to disagree. This module fetches summaries and lays
 * them out.
 *
 * Reloads are wholesale rather than surgical for the same reason: pinning one
 * entry can change the fill of every budget that client has, so patching a
 * single card would leave the rest of the page quietly wrong.
 */

const FILTERS = {
    active: (b) => b.is_active,
    upcoming: (b) => b.status === 'upcoming',
    closed: (b) => b.status === 'closed',
    all: () => true,
}

class Budgets extends TimeKeeper {
    constructor() {
        super()

        this.list = document.getElementById('budget-list')
        this.subtitle = document.getElementById('budgets-subtitle')
        this.overview = document.getElementById('budgets-overview')
        this.statusFilter = document.getElementById('status-filter')
        this.clientFilter = document.getElementById('client-filter')
        this.unbudgetedNote = document.getElementById('unbudgeted-note')

        this.formModal = document.getElementById('budget-form-modal')
        this.form = document.getElementById('budget-form')
        this.formTitle = document.getElementById('budget-form-title')
        this.saveButton = document.getElementById('budget-save')
        this.deleteButton = document.getElementById('budget-delete')
        this.capacityHint = document.getElementById('budget-capacity-hint')

        this.detailModal = document.getElementById('budget-detail-modal')
        this.detailBody = document.getElementById('budget-detail-body')
        this.detailTitle = document.getElementById('budget-detail-title')
        this.detailRange = document.getElementById('budget-detail-range')
        this.detailEdit = document.getElementById('budget-detail-edit')

        this.fields = {
            name: document.getElementById('budget-name'),
            client: document.getElementById('budget-client'),
            range: document.getElementById('budget-range'),
            hours: document.getElementById('budget-hours'),
            notes: document.getElementById('budget-notes'),
        }

        // The two dates the form actually submits. Mirrors what's picked in
        // the range field rather than being read back out of it, since a
        // single-day pick renders as one date with no ' to ' separator to
        // split on.
        this.range = { start: '', end: '' }

        this.budgets = []
        this.filter = 'active'
        this.editing = null
        this.detailId = null
        this.chart = null

        // Guards a slow response from painting over a newer one — the same
        // problem works.js solves with its loadToken.
        this.loadToken = 0
    }

    async init() {
        this.bindFilters()
        this.bindForm()
        this.bindModals()
        this.bindTheme()
        await this.load()
    }

    // -- loading -----------------------------------------------------------

    async load() {
        const token = ++this.loadToken

        try {
            const budgets = await this.fetchFromAPI('/api/budgets')
            if (token !== this.loadToken) return
            this.budgets = budgets
            this.render()
        } catch (error) {
            if (token !== this.loadToken) return
            // Never leave a loading placeholder up: say what's happening and
            // keep trying, since the server is local and will come back.
            this.list.innerHTML =
                '<div class="tk-card tk-empty py-10">Reconnecting…</div>'
            setTimeout(() => this.load().catch((e) => console.error(e)), 3000)
        }
    }

    // -- rendering ---------------------------------------------------------

    visible() {
        const clientId = this.clientFilter.value
        return this.budgets
            .filter(FILTERS[this.filter])
            .filter((b) => !clientId || String(b.client_id) === clientId)
    }

    render() {
        this.renderOverview()
        this.renderList()
        // Independent request; the list should not wait on it.
        this.updateUnbudgeted().catch((e) => console.error(e))
    }

    renderOverview() {
        const active = this.budgets.filter((b) => b.is_active)

        if (!this.budgets.length) {
            this.overview.classList.add('hidden')
            this.subtitle.textContent = 'Hours committed, hours spent.'
            return
        }

        const budgeted = active.reduce((sum, b) => sum + b.budgeted_hours, 0)
        const used = active.reduce((sum, b) => sum + b.used_hours, 0)
        const risk = active.filter((b) => b.status === 'over' || b.status === 'at_risk')

        document.getElementById('overview-count').textContent = active.length
        document.getElementById('overview-budgeted').textContent = hours(budgeted)
        document.getElementById('overview-used').textContent =
            `${hours(used)}${budgeted ? ` · ${percent((used / budgeted) * 100)}` : ''}`

        const riskEl = document.getElementById('overview-risk')
        riskEl.textContent = risk.length
        // The one figure on this row that should draw the eye when non-zero.
        riskEl.classList.toggle('text-danger', risk.length > 0)
        riskEl.classList.toggle('text-text', risk.length === 0)

        this.overview.classList.remove('hidden')
        this.subtitle.textContent =
            `${this.budgets.length} budget${this.budgets.length === 1 ? '' : 's'}`
            + ` · ${active.length} running now`
    }

    renderList() {
        const budgets = this.visible()

        if (!budgets.length) {
            this.list.innerHTML = `<div class="tk-card tk-empty py-10">${
                this.budgets.length
                    ? 'No budgets match this filter.'
                    : 'No budgets yet. Create one to start tracking hours against a commitment.'
            }</div>`
            return
        }

        this.list.innerHTML = budgets.map((b) => this.card(b)).join('')

        this.list.querySelectorAll('[data-budget-id]').forEach((card) => {
            card.addEventListener('click', () => this.openDetail(Number(card.dataset.budgetId)))
            card.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                this.openDetail(Number(card.dataset.budgetId))
            })
        })
    }

    card(budget) {
        const pace = paceNote(budget)

        // Days-left reads better than a second date on a card that already
        // carries the range in its subhead.
        const daysLeft =
            budget.status === 'closed' || budget.status === 'upcoming'
                ? shortDate(budget.end_date)
                : `${budget.remaining_business_days} work day${
                      budget.remaining_business_days === 1 ? '' : 's'
                  }`

        return `
          <article class="tk-budget-card is-clickable p-4" data-status="${budget.status}"
                   data-budget-id="${budget.id}" tabindex="0" role="button"
                   aria-label="${this.escapeHtml(budget.name)} — ${headline(budget)}">
            <div class="mb-3 flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 class="truncate text-[0.9375rem] font-semibold text-text">${this.escapeHtml(budget.name)}</h2>
                <p class="tabular mt-0.5 truncate text-xs text-faint">
                  ${this.escapeHtml(budget.client_name ?? 'Unknown client')} · ${dateRange(budget)}
                </p>
              </div>
              <span class="tk-badge tk-badge-status flex-shrink-0">${STATUS_LABEL[budget.status]}</span>
            </div>

            <div class="mb-2 flex items-baseline justify-between gap-3">
              <span class="tabular text-sm font-semibold text-text">
                ${hours(budget.used_hours)}<span class="font-normal text-faint"> / ${hours(budget.budgeted_hours)} hrs</span>
              </span>
              <span class="tabular text-sm font-semibold" style="color: var(--status-text)">${percent(budget.percent_used)}</span>
            </div>

            ${meter(budget, { large: true })}

            <p class="mt-2.5 text-xs text-muted">${this.escapeHtml(headline(budget))}</p>

            <div class="mt-3 grid grid-cols-4 gap-3 border-t border-border pt-3">
              <div>
                <div class="tk-stat-label">Remaining</div>
                <div class="tk-stat-value">${hours(budget.remaining_hours)}<span class="font-normal text-faint"> hrs</span></div>
              </div>
              <div>
                <div class="tk-stat-label">Projected</div>
                <div class="tk-stat-value">${hours(budget.projected_hours)}<span class="font-normal text-faint"> hrs</span></div>
              </div>
              <div>
                <div class="tk-stat-label">Pace</div>
                <div class="tk-stat-value">${hours(budget.pace_hours_per_day)}<span class="font-normal text-faint"> /day</span></div>
              </div>
              <div>
                <div class="tk-stat-label">Time left</div>
                <div class="tk-stat-value">${daysLeft}</div>
              </div>
            </div>

            ${pace ? `<p class="mt-2 text-xs text-faint">${this.escapeHtml(pace)}</p>` : ''}
          </article>
        `
    }

    // -- filters -----------------------------------------------------------

    bindFilters() {
        this.statusFilter.addEventListener('click', (event) => {
            const button = event.target.closest('[data-filter]')
            if (!button) return

            this.filter = button.dataset.filter
            this.statusFilter.querySelectorAll('[data-filter]').forEach((b) => {
                const selected = b === button
                b.classList.toggle('active', selected)
                b.setAttribute('aria-checked', selected ? 'true' : 'false')
            })
            this.renderList()
        })

        this.clientFilter.addEventListener('change', () => {
            this.renderList()
            this.updateUnbudgeted().catch((e) => console.error(e))
        })
    }

    /**
     * "N hrs recorded for this client fall outside every budget."
     *
     * The one thing the cards genuinely cannot show: a stretch nobody wrote a
     * budget for looks exactly like a stretch with nothing recorded in it.
     * Per-client only — totalling it across clients with different coverage
     * would be a number that means nothing.
     */
    async updateUnbudgeted() {
        const clientId = this.clientFilter.value
        if (!clientId) {
            this.unbudgetedNote.classList.add('hidden')
            return
        }

        try {
            const { unbudgeted_hours: loose } = await this.fetchFromAPI(
                `/api/budgets/unbudgeted/${clientId}`
            )
            if (this.clientFilter.value !== clientId) return

            if (!loose) {
                this.unbudgetedNote.classList.add('hidden')
                return
            }
            this.unbudgetedNote.innerHTML =
                `<span class="tabular font-semibold text-text">${hours(loose)} hrs</span>`
                + ' recorded for this client fall outside every budget.'
            this.unbudgetedNote.classList.remove('hidden')
        } catch (error) {
            // Supplementary information — nothing on the page depends on it.
            this.unbudgetedNote.classList.add('hidden')
        }
    }

    // -- create / edit -----------------------------------------------------

    bindForm() {
        document.getElementById('new-budget').addEventListener('click', () => this.openForm())

        this.form.addEventListener('submit', (event) => {
            event.preventDefault()
            this.submit().catch((e) => console.error(e))
        })

        this.deleteButton.addEventListener('click', () => {
            this.remove().catch((e) => console.error(e))
        })

        // Capacity context updates as you pick, so an unrealistic figure is
        // obvious before it's saved rather than after it's blown.
        this.rangePicker = flatpickr(this.fields.range, {
            mode: 'range',
            dateFormat: 'Y-m-d',
            showMonths: 2,
            // Left calendar defaults to the *start* month. Flatpickr would
            // otherwise open centered on whichever date was picked last —
            // the end, most of the time — which buries the start of a
            // multi-month budget a click away.
            onOpen: () => {
                if (this.range.start) this.rangePicker.jumpToDate(this.range.start)
            },
            onChange: (selectedDates) => {
                if (selectedDates.length === 2) {
                    this.range.start = this.toISO(selectedDates[0])
                    this.range.end = this.toISO(selectedDates[1])
                    this.updateCapacityHint()
                }
            },
            // Clicking just one date and closing the calendar almost always
            // means a period of the same length again — default the end to
            // the last day of that month, same as a single click used to do
            // with the old start/end inputs.
            onClose: (selectedDates) => {
                if (selectedDates.length !== 1) return
                const [y, m, d] = this.toISO(selectedDates[0]).split('-').map(Number)
                const end = new Date(y, m - 1 + 1, d - 1)
                this.rangePicker.setDate([selectedDates[0], end], true)
            },
        })
        this.fields.hours.addEventListener('input', () => this.updateCapacityHint())
    }

    toISO(date) {
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')
        return `${date.getFullYear()}-${month}-${day}`
    }

    openForm(budget = null) {
        this.editing = budget

        this.formTitle.textContent = budget ? 'Edit budget' : 'New budget'
        this.saveButton.textContent = budget ? 'Save changes' : 'Create budget'
        this.deleteButton.classList.toggle('hidden', !budget)

        this.fields.name.value = budget?.name ?? ''
        this.fields.client.value = budget ? String(budget.client_id) : ''
        this.fields.hours.value = budget?.budgeted_hours ?? ''
        this.fields.notes.value = budget?.notes ?? ''

        this.range.start = budget?.start_date ?? this.toISO(new Date())
        if (budget) {
            this.range.end = budget.end_date
        } else {
            // Same default a single click on the old start field used to
            // produce: the rest of that month.
            const [y, m, d] = this.range.start.split('-').map(Number)
            this.range.end = this.toISO(new Date(y, m - 1 + 1, d - 1))
        }
        this.rangePicker.setDate([this.range.start, this.range.end], false)

        this.updateCapacityHint()
        this.showModal(this.formModal)
        this.fields.name.focus()
    }

    /**
     * How much of the period's total working time the budget would consume.
     *
     * Computed client-side from the same weekday rule the server uses, because
     * a round trip per keystroke to tell someone their number is large would be
     * absurd. The authoritative figure is still whatever comes back on save.
     */
    updateCapacityHint() {
        const { start, end } = this.range
        const budgeted = Number(this.fields.hours.value)

        if (!start || !end || !budgeted) {
            this.capacityHint.textContent = ''
            return
        }

        const days = this.businessDaysBetween(start, end)
        if (!days) {
            this.capacityHint.textContent = 'That period contains no working days.'
            return
        }

        const perDay = budgeted / days
        this.capacityHint.textContent =
            `${days} working day${days === 1 ? '' : 's'} · ${hours(perDay)} hrs/day to spend it evenly`
    }

    businessDaysBetween(startISO, endISO) {
        const [sy, sm, sd] = startISO.split('-').map(Number)
        const [ey, em, ed] = endISO.split('-').map(Number)
        const day = new Date(sy, sm - 1, sd)
        const end = new Date(ey, em - 1, ed)
        if (end < day) return 0

        let count = 0
        while (day <= end) {
            if (day.getDay() !== 0 && day.getDay() !== 6) count++
            day.setDate(day.getDate() + 1)
        }
        return count
    }

    async submit() {
        const payload = {
            name: this.fields.name.value.trim(),
            client_id: Number(this.fields.client.value),
            start_date: this.range.start,
            end_date: this.range.end,
            budgeted_hours: Number(this.fields.hours.value),
            notes: this.fields.notes.value.trim(),
        }

        const editing = this.editing
        this.saveButton.disabled = true

        try {
            // `quiet` because the server's message is rendered as a toast here
            // with the right wording; fetchFromAPI would raise a second one.
            await this.fetchFromAPI(
                editing ? `/api/budgets/${editing.id}` : '/api/budgets',
                {
                    method: editing ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
                { quiet: true }
            )

            this.hideModal(this.formModal)
            this.showToast(editing ? 'Budget updated' : 'Budget created', 'success')
            await this.load()

            // Re-open the detail view on top of fresh figures if that's where
            // the edit came from.
            if (editing && this.detailId === editing.id) await this.openDetail(editing.id)
        } catch (error) {
            this.showToast(error.message, 'error')
        } finally {
            this.saveButton.disabled = false
        }
    }

    async remove() {
        const budget = this.editing
        if (!budget) return

        // Two-step rather than a confirm dialog, matching how the client
        // manager arms a delete.
        if (!this.deleteButton.classList.contains('tk-btn-danger-armed')) {
            this.deleteButton.classList.add('tk-btn-danger-armed')
            this.deleteButton.textContent = 'Really delete?'
            setTimeout(() => {
                this.deleteButton.classList.remove('tk-btn-danger-armed')
                this.deleteButton.textContent = 'Delete'
            }, 4000)
            return
        }

        try {
            await this.fetchFromAPI(
                `/api/budgets/${budget.id}`,
                { method: 'DELETE' },
                { quiet: true }
            )
            this.hideModal(this.formModal)
            this.hideModal(this.detailModal)
            this.detailId = null
            this.showToast('Budget deleted. The time it tracked is untouched.', 'success')
            await this.load()
        } catch (error) {
            this.showToast(error.message, 'error')
        } finally {
            this.deleteButton.classList.remove('tk-btn-danger-armed')
            this.deleteButton.textContent = 'Delete'
        }
    }

    // -- detail ------------------------------------------------------------

    async openDetail(budgetId) {
        this.detailId = budgetId
        this.detailBody.innerHTML = '<div class="tk-empty py-10">Loading…</div>'
        this.showModal(this.detailModal)

        try {
            const detail = await this.fetchFromAPI(`/api/budgets/${budgetId}`)
            // Another card may have been opened while this was in flight.
            if (this.detailId !== budgetId) return
            this.renderDetail(detail)
        } catch (error) {
            if (this.detailId !== budgetId) return
            this.detailBody.innerHTML =
                '<div class="tk-empty py-10">Could not load this budget. Close and try again.</div>'
        }
    }

    renderDetail(detail) {
        this.detail = detail
        this.detailTitle.textContent = detail.name
        this.detailRange.textContent =
            `${detail.client_name ?? 'Unknown client'} · ${dateRange(detail)}`

        // Closes the summary rather than stacking the form on top of it —
        // two overlapping backdrops plus a wide detail view behind a narrow
        // form modal made for a visibly janky transition.
        this.detailEdit.onclick = () => {
            this.hideModal(this.detailModal)
            this.openForm(detail)
        }

        this.detailBody.innerHTML = `
          <div class="tk-budget-card border-0 p-0 shadow-none" data-status="${detail.status}">
            <div class="mb-2 flex items-baseline justify-between gap-3">
              <span class="tabular text-lg font-semibold text-text">
                ${hours(detail.used_hours)}<span class="font-normal text-faint"> / ${hours(detail.budgeted_hours)} hrs</span>
              </span>
              <span class="tk-badge tk-badge-status">${STATUS_LABEL[detail.status]}</span>
            </div>
            ${meter(detail, { large: true })}
            <p class="mt-2 text-sm text-muted">${this.escapeHtml(headline(detail))}</p>
          </div>

          <div class="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-4">
            ${this.detailStat('Used', `${hours(detail.used_hours)} hrs`, percent(detail.percent_used))}
            ${this.detailStat('Remaining', `${hours(detail.remaining_hours)} hrs`, `${detail.remaining_business_days} work days`)}
            ${this.detailStat('Projected', `${hours(detail.projected_hours)} hrs`, percent(detail.projected_percent))}
            ${this.detailStat('Period gone', percent(detail.percent_elapsed), `${detail.elapsed_business_days}/${detail.total_business_days} days`)}
          </div>

          <!-- The capacity read is the insight the settings figure buys: it
               answers "is this deliverable at all", separately from "am I on
               pace". -->
          <p class="mt-3 text-xs text-muted">
            This budget is <span class="tabular font-semibold text-text">${percent(detail.capacity_share)}</span>
            of everything you could work in the period
            (<span class="tabular">${hours(detail.total_capacity_hours)}</span> hrs).
            ${
                detail.required_hours_per_day != null && detail.required_hours_per_day >= 0
                    ? `From tomorrow you have <span class="tabular font-semibold text-text">${hours(detail.required_hours_per_day)}</span> hrs/day to play with.`
                    : ''
            }
          </p>

          <div class="mt-5">
            <h3 class="tk-card-title mb-2">Burn</h3>
            <div class="h-52"><canvas id="burn-chart"></canvas></div>
          </div>

          <div class="mt-5">
            <div class="mb-2 flex items-center justify-between gap-3">
              <h3 class="tk-card-title">Time entries</h3>
              <span class="text-xs text-faint">${detail.entries.length} entr${detail.entries.length === 1 ? 'y' : 'ies'}</span>
            </div>
            ${this.entriesTable(detail)}
          </div>
        `

        this.drawBurnChart(detail)
        this.bindEntryPins(detail)
    }

    detailStat(label, value, sub) {
        return `
          <div class="bg-surface px-3 py-2.5">
            <div class="tk-stat-label">${label}</div>
            <div class="tabular mt-0.5 text-base font-semibold text-text">${value}</div>
            <div class="tabular text-[0.6875rem] text-faint">${sub}</div>
          </div>
        `
    }

    /**
     * Contributing entries, each with a budget selector.
     *
     * This table is the answer to overlapping budgets. The allocator's default
     * is deterministic but it can't know that Tuesday afternoon was really the
     * other engagement — so every row can be reassigned, and a row that has
     * been says so, because a pinned entry no longer follows the rules the rest
     * of the table follows.
     */
    entriesTable(detail) {
        if (!detail.entries.length) {
            return '<div class="tk-empty py-6">No time has landed on this budget yet.</div>'
        }

        const options = (selected) =>
            [
                `<option value="">Auto (bucket fill)</option>`,
                ...detail.sibling_budgets.map(
                    (b) =>
                        `<option value="${b.id}"${b.id === selected ? ' selected' : ''}>${this.escapeHtml(b.name)}</option>`
                ),
            ].join('')

        const rows = detail.entries
            .map(
                (entry) => `
          <tr>
            <td class="tk-num whitespace-nowrap">${shortDate(entry.date)}</td>
            <td class="tk-num whitespace-nowrap text-muted">
              ${entry.start_time ?? '—'}${entry.end_time ? `–${entry.end_time}` : ''}
              ${entry.running ? '<span class="tk-badge tk-badge-accent ml-1.5">running</span>' : ''}
            </td>
            <td class="tk-num text-right font-medium">
              ${hours(entry.hours)}
              ${entry.split ? '<span class="tk-badge tk-badge-neutral ml-1.5" title="This entry was split across more than one budget">split</span>' : ''}
            </td>
            <td class="w-px">
              <select class="tk-select tk-select-sm w-44" data-task-id="${entry.task_id}"
                      aria-label="Budget for this entry">
                ${options(entry.pinned ? detail.id : null)}
              </select>
            </td>
          </tr>
        `
            )
            .join('')

        return `
          <div class="overflow-hidden rounded-lg border border-border">
            <table class="tk-table tk-table-hover">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Time</th>
                  <th class="text-right">Hours</th>
                  <th>Assigned to</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `
    }

    bindEntryPins(detail) {
        this.detailBody.querySelectorAll('[data-task-id]').forEach((select) => {
            select.addEventListener('change', async () => {
                const taskId = Number(select.dataset.taskId)
                const value = select.value ? Number(select.value) : null
                const previous = select.dataset.previous ?? ''

                select.disabled = true
                try {
                    await this.fetchFromAPI(
                        `/api/tasks/${taskId}/budget`,
                        {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ budget_id: value }),
                        },
                        { quiet: true }
                    )

                    this.showToast(
                        value ? 'Entry pinned to that budget' : 'Entry released to the allocator',
                        'success'
                    )

                    // Reassignment changes the fill of every overlapping budget
                    // for this client, so both views are rebuilt from scratch.
                    await this.load()
                    await this.openDetail(detail.id)
                } catch (error) {
                    select.value = previous
                    this.showToast(error.message, 'error')
                } finally {
                    select.disabled = false
                }
            })

            select.dataset.previous = select.value
        })
    }

    /**
     * Cumulative hours against the capacity-paced ideal.
     *
     * The ideal line steps rather than sloping — it's flat at weekends —
     * because a straight diagonal makes every budget look behind on Monday and
     * ahead on Friday. Colours are read from the live CSS variables and the
     * chart is rebuilt on `themeChanged`, since Chart.js bakes them in at
     * construction.
     */
    drawBurnChart(detail) {
        const canvas = document.getElementById('burn-chart')
        if (!canvas || typeof Chart === 'undefined') return

        if (this.chart) this.chart.destroy()

        const css = getComputedStyle(document.documentElement)
        const token = (name) => css.getPropertyValue(name).trim()

        const overBudget = detail.status === 'over'

        this.chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: detail.burn.map((p) => shortDate(p.date)),
                datasets: [
                    {
                        label: 'Actual',
                        data: detail.burn.map((p) => p.actual),
                        borderColor: overBudget ? token('--danger') : token('--accent'),
                        backgroundColor: overBudget ? token('--danger-soft') : token('--accent-soft'),
                        borderWidth: 2,
                        fill: true,
                        pointRadius: 0,
                        // A gap in `actual` is the future, not missing data.
                        spanGaps: false,
                        tension: 0.15,
                    },
                    {
                        label: 'On-budget pace',
                        data: detail.burn.map((p) => p.ideal),
                        borderColor: token('--faint'),
                        borderWidth: 1.5,
                        borderDash: [4, 4],
                        pointRadius: 0,
                        fill: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        labels: {
                            color: token('--muted'),
                            boxWidth: 12,
                            boxHeight: 12,
                            usePointStyle: true,
                        },
                    },
                    tooltip: {
                        callbacks: {
                            label: (ctx) =>
                                ctx.parsed.y == null
                                    ? undefined
                                    : `${ctx.dataset.label}: ${hours(ctx.parsed.y)} hrs`,
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: token('--faint'), maxTicksLimit: 8 },
                        grid: { color: token('--border'), drawBorder: false },
                    },
                    y: {
                        beginAtZero: true,
                        ticks: { color: token('--faint') },
                        grid: { color: token('--border'), drawBorder: false },
                    },
                },
            },
        })
    }

    bindTheme() {
        // Chart.js resolves colours once, at construction — see the note in
        // CLAUDE.local.md. Redraw from the current tokens when the theme moves.
        document.addEventListener('themeChanged', () => {
            if (this.detail && !this.detailModal.classList.contains('hidden')) {
                this.drawBurnChart(this.detail)
            }
        })
    }

    // -- modals ------------------------------------------------------------

    bindModals() {
        document.querySelectorAll('[data-close-modal]').forEach((button) => {
            button.addEventListener('click', () =>
                this.hideModal(button.closest('.tk-modal-backdrop'))
            )
        })

        // Backdrop click and Escape, both of which people reach for without
        // thinking about it.
        ;[this.formModal, this.detailModal].forEach((modal) => {
            modal.addEventListener('mousedown', (event) => {
                if (event.target === modal) this.hideModal(modal)
            })
        })

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return
            if (!this.formModal.classList.contains('hidden')) this.hideModal(this.formModal)
            else if (!this.detailModal.classList.contains('hidden')) this.hideModal(this.detailModal)
        })
    }

    showModal(modal) {
        if (!modal.classList.contains('hidden')) return
        modal.classList.remove('hidden')
        lockBodyScroll()
    }

    hideModal(modal) {
        if (!modal || modal.classList.contains('hidden')) return
        modal.classList.add('hidden')
        unlockBodyScroll()

        if (modal === this.formModal) {
            this.editing = null
            this.deleteButton.classList.remove('tk-btn-danger-armed')
            this.deleteButton.textContent = 'Delete'
        }
        if (modal === this.detailModal) {
            this.detailId = null
            this.detail = null
            if (this.chart) {
                this.chart.destroy()
                this.chart = null
            }
        }
    }
}

ready(() => {
    const page = new Budgets()
    page.init().catch((error) => {
        console.error('Budgets page init failed, retrying:', error)
        setTimeout(() => page.init().catch((e) => console.error(e)), 3000)
    })
})
