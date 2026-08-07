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
    // Paused budgets stay under "active" rather than getting a tab of their
    // own. A held engagement is still live work you've committed to — filing it
    // somewhere you don't look is how a two-week pause quietly becomes two
    // months. The dashed card and the badge are what mark it out.
    active: (b) => b.is_active,
    upcoming: (b) => b.status === 'upcoming',
    // An ended budget can deliberately keep an "over budget" badge, so the
    // closed tab follows whether it is still active rather than badge text.
    closed: (b) => b.started && !b.is_active,
    all: () => true,
}

const INSIGHTS = {
    used: 'Task time allocated to this budget. Each client\'s daily time is rounded to the nearest quarter hour.',
    projected: 'Estimated total at the end date if your capacity-weighted pace so far continues. Weekends and held days are excluded.',
    pace: 'Average hours used per elapsed working day. Weekends and held days are excluded.',
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
        this.detailCloseBudget = document.getElementById('budget-detail-close-budget')

        this.fields = {
            name: document.getElementById('budget-name'),
            client: document.getElementById('budget-client'),
            range: document.getElementById('budget-range'),
            hours: document.getElementById('budget-hours'),
            riskThreshold: document.getElementById('budget-risk-threshold'),
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
        this.formReturnBudgetId = null
        this.detailId = null
        this.chart = null
        this.closeBudgetResetTimer = null

        // Guards a slow response from painting over a newer one — the same
        // problem works.js solves with its loadToken.
        this.loadToken = 0
    }

    async init() {
        this.bindFilters()
        this.bindForm()
        this.bindModals()
        this.bindInsights()
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
            this.subtitle.textContent = 'Hours budgeted, hours spent.'
            return
        }

        const budgeted = active.reduce((sum, b) => sum + b.budgeted_hours, 0)
        const used = active.reduce((sum, b) => sum + b.used_hours, 0)
        const atRisk = active.filter((b) => b.status === 'at_risk')
        const overBudget = active.filter((b) => b.status === 'over')

        document.getElementById('overview-count').textContent = active.length
        document.getElementById('overview-budgeted').textContent = hours(budgeted)
        document.getElementById('overview-used').textContent =
            `${hours(used)}${budgeted ? ` · ${percent((used / budgeted) * 100)}` : ''}`

        const atRiskEl = document.getElementById('overview-at-risk')
        atRiskEl.textContent = atRisk.length
        atRiskEl.classList.toggle('text-warn', atRisk.length > 0)
        atRiskEl.classList.toggle('text-text', atRisk.length === 0)

        const riskEl = document.getElementById('overview-risk')
        riskEl.textContent = overBudget.length
        // Already-over work is the strongest warning on this row.
        riskEl.classList.toggle('text-danger', overBudget.length > 0)
        riskEl.classList.toggle('text-text', overBudget.length === 0)

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
            card.addEventListener('click', (event) => {
                if (event.target.closest('.tk-insight')) return
                this.openDetail(Number(card.dataset.budgetId))
            })
            card.addEventListener('keydown', (event) => {
                if (event.target.closest('.tk-insight')) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                this.openDetail(Number(card.dataset.budgetId))
            })
        })
    }

    card(budget) {
        const pace = paceNote(budget)
        const diagnosis = this.diagnosisInsight(budget)

        // Days-left reads better than a second date on a card that already
        // carries the range in its subhead.
        const daysLeft =
            budget.status === 'closed' || budget.status === 'upcoming'
                ? shortDate(budget.end_date)
                : `${budget.remaining_business_days} work day${
                      budget.remaining_business_days === 1 ? '' : 's'
                  }`

        // Said on the card rather than buried in the detail view, because it's
        // the number that explains why the rest of the card looks the way it
        // does — a projection built on eight working days instead of twenty.
        const holdNote =
            budget.held_business_days > 0
                ? `${budget.held_business_days} work day${
                      budget.held_business_days === 1 ? '' : 's'
                  } on hold, excluded from every figure here`
                : null

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
              <div class="flex flex-shrink-0 items-center gap-1.5">
                <span class="tk-badge tk-badge-status">${STATUS_LABEL[budget.status]}</span>
                ${diagnosis ? this.insightIcon(diagnosis, `${STATUS_LABEL[budget.status]} diagnosis`) : ''}
              </div>
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
                ${this.insightLabel('Projected', INSIGHTS.projected)}
                <div class="tk-stat-value">${hours(budget.projected_hours)}<span class="font-normal text-faint"> hrs</span></div>
              </div>
              <div>
                ${this.insightLabel('Pace', INSIGHTS.pace)}
                <div class="tk-stat-value">${hours(budget.pace_hours_per_day)}<span class="font-normal text-faint"> /day</span></div>
              </div>
              <div>
                <div class="tk-stat-label">Time left</div>
                <div class="tk-stat-value">${daysLeft}</div>
              </div>
            </div>

            ${pace ? `<p class="mt-2 text-xs text-faint">${this.escapeHtml(pace)}</p>` : ''}
            ${holdNote ? `<p class="mt-2 text-xs text-faint">${this.escapeHtml(holdNote)}</p>` : ''}
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

    openForm(budget = null, { returnToDetail = false } = {}) {
        this.editing = budget
        this.formReturnBudgetId = returnToDetail && budget ? budget.id : null

        this.formTitle.textContent = budget ? 'Edit budget' : 'New budget'
        this.saveButton.textContent = budget ? 'Save changes' : 'Create budget'
        this.deleteButton.classList.toggle('hidden', !budget)

        this.fields.name.value = budget?.name ?? ''
        this.fields.client.value = budget ? String(budget.client_id) : ''
        this.fields.hours.value = budget?.budgeted_hours ?? ''
        this.fields.riskThreshold.value = budget?.risk_threshold_percent ?? 10
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
            risk_threshold_percent: Number(this.fields.riskThreshold.value),
            notes: this.fields.notes.value.trim(),
        }

        const editing = this.editing
        const returnBudgetId = this.formReturnBudgetId
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

            // Wait to restore the detail view until the list reload has
            // completed, so it opens with the newly saved figures.
            this.hideModal(this.formModal, { reopenDetail: false })
            this.showToast(editing ? 'Budget updated' : 'Budget created', 'success')
            await this.load()

            if (editing && returnBudgetId) await this.openDetail(returnBudgetId)
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
            this.hideModal(this.formModal, { reopenDetail: false })
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

    resetCloseBudgetButton() {
        if (this.closeBudgetResetTimer) {
            clearTimeout(this.closeBudgetResetTimer)
            this.closeBudgetResetTimer = null
        }
        this.detailCloseBudget.disabled = false
        this.detailCloseBudget.classList.remove('tk-btn-danger-armed')
        this.detailCloseBudget.textContent = 'Close budget'
    }

    async closeBudget() {
        const detail = this.detail
        if (!detail?.is_active || detail.closed_at) return

        // Closing stops future automatic allocation, so require the same
        // deliberate second click used by Delete without interrupting the
        // flow with a browser-native confirmation dialog.
        if (!this.detailCloseBudget.classList.contains('tk-btn-danger-armed')) {
            this.detailCloseBudget.classList.add('tk-btn-danger-armed')
            this.detailCloseBudget.textContent = 'Really close?'
            this.closeBudgetResetTimer = setTimeout(() => {
                this.closeBudgetResetTimer = null
                this.resetCloseBudgetButton()
            }, 4000)
            return
        }

        this.detailCloseBudget.disabled = true
        try {
            await this.fetchFromAPI(
                `/api/budgets/${detail.id}/close`,
                { method: 'POST' },
                { quiet: true }
            )
            this.showToast('Budget closed. Time on later dates will no longer be allocated to it.', 'success')
            await this.load()
            if (this.detailId === detail.id) await this.openDetail(detail.id)
        } catch (error) {
            this.showToast(error.message, 'error')
            this.resetCloseBudgetButton()
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
        const canClose = detail.is_active && !detail.closed_at
        const diagnosis = this.diagnosisInsight(detail)
        this.detailCloseBudget.classList.toggle('hidden', !canClose)
        this.resetCloseBudgetButton()

        this.detail = detail
        this.detailTitle.textContent = detail.name
        this.detailRange.textContent =
            `${detail.client_name ?? 'Unknown client'} · ${dateRange(detail)}`

        // Closes the summary rather than stacking the form on top of it —
        // two overlapping backdrops plus a wide detail view behind a narrow
        // form modal made for a visibly janky transition.
        this.detailEdit.onclick = () => {
            this.hideModal(this.detailModal)
            this.openForm(detail, { returnToDetail: true })
        }

        this.detailBody.innerHTML = `
          <div class="tk-budget-card border-0 p-0 shadow-none" data-status="${detail.status}">
            <div class="mb-2 flex items-baseline justify-between gap-3">
              <span class="tabular text-lg font-semibold text-text">
                ${hours(detail.used_hours)}<span class="font-normal text-faint"> / ${hours(detail.budgeted_hours)} hrs</span>
              </span>
              <div class="flex items-center gap-1.5">
                <span class="tk-badge tk-badge-status">${STATUS_LABEL[detail.status]}</span>
                ${diagnosis ? this.insightIcon(diagnosis, `${STATUS_LABEL[detail.status]} diagnosis`) : ''}
              </div>
            </div>
            ${meter(detail, { large: true })}
            <p class="mt-2 text-sm text-muted">${this.escapeHtml(headline(detail))}</p>
          </div>

          <div class="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-4">
            ${this.detailStat('Used', `${hours(detail.used_hours)} hrs`, percent(detail.percent_used), INSIGHTS.used)}
            ${this.detailStat('Remaining', `${hours(detail.remaining_hours)} hrs`, `${detail.remaining_business_days} work days`)}
            ${this.detailStat('Projected', `${hours(detail.projected_hours)} hrs`, percent(detail.projected_percent), INSIGHTS.projected)}
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

          ${this.holdsSection(detail)}

          <div class="mt-5">
            <div class="mb-2 flex items-center justify-between gap-3">
              <h3 class="tk-card-title">Time entries</h3>
              <span class="text-xs text-faint">${detail.entries.length} entr${detail.entries.length === 1 ? 'y' : 'ies'}</span>
            </div>
            ${this.entriesTable(detail)}
          </div>

          <div class="mt-5">
            <div class="mb-2 flex items-center justify-between gap-3">
              <h3 class="tk-card-title">Not associated with a budget</h3>
              <span class="text-xs text-faint">${detail.unassigned_entries.length} entr${detail.unassigned_entries.length === 1 ? 'y' : 'ies'}</span>
            </div>
            ${this.unassignedEntriesTable(detail)}
          </div>
        `

        this.drawBurnChart(detail)
        this.bindEntryPins(detail)
        this.bindHolds(detail)
    }

    /**
     * Holds — the periods this project was paused.
     *
     * Lives directly below the burn chart so the graph is encountered first
     * and its held-day shading leads naturally into the dates that explain it.
     *
     * Two ways in, because there are two genuinely different situations:
     *
     * - **"Pause from today"** takes no dates. You pause on the day the work
     *   stops, and the day it restarts isn't something you know yet.
     * - **"Record a past hold"** takes a range, because pauses are very often
     *   noticed weeks later — the projection looks wrong, and the reason is
     *   that nobody touched the project for a fortnight in March. Without this
     *   the feature only helps people who remembered to press a button at the
     *   time, which is nobody.
     *
     * Both land in the same table, and any row can be edited or removed.
     */
    holdsSection(detail) {
        const holds = detail.holds ?? []

        const rows = holds
            .map(
                (hold) => `
          <tr>
            <td class="tk-num whitespace-nowrap">${shortDate(hold.start_date)}</td>
            <td class="tk-num whitespace-nowrap">
              ${
                  hold.end_date
                      ? shortDate(hold.end_date)
                      : '<span class="text-muted">still on hold</span>'
              }
            </td>
            <td class="text-muted">${this.escapeHtml(hold.reason ?? '—')}</td>
            <td class="w-px whitespace-nowrap">
              <button type="button" class="tk-btn tk-btn-ghost tk-btn-sm"
                      data-edit-hold="${hold.id}"
                      title="Change these dates">Edit</button>
              <button type="button" class="tk-btn tk-btn-ghost tk-btn-sm"
                      data-remove-hold="${hold.id}"
                      title="Remove this hold — the days count as worked again">Remove</button>
            </td>
          </tr>
        `
            )
            .join('')

        const table = holds.length
            ? `
          <div class="overflow-hidden rounded-lg border border-border">
            <table class="tk-table tk-table-hover">
              <thead>
                <tr><th>From</th><th>Until</th><th>Reason</th><th></th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`
            : '<div class="tk-empty py-4">This project has never been on hold.</div>'

        // Time recorded during a hold isn't hidden or subtracted — it's in
        // used_hours like everything else, because the client's hours have to
        // reconcile. It's called out here because it almost always means the
        // hold dates are wrong rather than that the rule is.
        const heldWarning =
            detail.held_hours > 0.05
                ? `<p class="mt-2 text-xs" style="color: var(--warn)">
                     ${hours(detail.held_hours)} hrs were recorded on days this project was on hold.
                     They still count — check the dates below.
                   </p>`
                : ''

        return `
          <div class="mt-5">
            <div class="mb-2 flex items-center justify-between gap-3">
              <h3 class="tk-card-title">Holds</h3>
              <div class="flex gap-2">
                <button type="button" id="add-hold" class="tk-btn tk-btn-ghost tk-btn-sm">Record a past hold</button>
                <button type="button" id="toggle-hold" class="tk-btn tk-btn-sm ${
                    detail.is_paused ? 'tk-btn-primary' : 'tk-btn-ghost'
                }">${detail.is_paused ? 'Resume now' : 'Pause from today'}</button>
              </div>
            </div>
            <p class="mb-2 text-xs text-faint">
              Held days are removed from this budget's capacity, so pace, projection and the
              ideal line above all ignore them.
              ${
                  detail.held_business_days > 0
                      ? `<span class="tabular font-semibold text-muted">${detail.held_business_days}</span> work day${
                            detail.held_business_days === 1 ? '' : 's'
                        } excluded so far.`
                      : ''
              }
            </p>

            <!-- Inline rather than a second modal. The holds table, the burn
                 chart and the entry list are the context you need while
                 picking the dates, and stacking a modal on the detail view
                 would hide all three. -->
            <!-- No panel fill: .tk-input is already --surface-2, so tinting
                 the panel the same way would make the fields disappear into
                 it. The border alone is enough to group them. -->
            <div id="hold-form" class="mb-2 hidden rounded-lg border border-border p-3">
              <div class="flex flex-wrap items-end gap-3">
                <div class="min-w-52 flex-1">
                  <label class="tk-label" for="hold-range">Paused between</label>
                  <input type="text" id="hold-range" class="tk-input tabular cursor-pointer"
                         placeholder="Select date range…" autocomplete="off" readonly />
                </div>
                <div class="min-w-52 flex-1">
                  <label class="tk-label" for="hold-reason">Reason <span class="normal-case tracking-normal text-faint">(optional)</span></label>
                  <input type="text" id="hold-reason" class="tk-input" maxlength="200"
                         placeholder="Awaiting client sign-off" autocomplete="off" />
                </div>
                <div class="flex gap-2">
                  <button type="button" id="hold-cancel" class="tk-btn tk-btn-secondary tk-btn-sm">Cancel</button>
                  <button type="button" id="hold-save" class="tk-btn tk-btn-primary tk-btn-sm">Save hold</button>
                </div>
              </div>
              <p class="mt-2 text-xs text-faint">
                Both ends are included. A hold may run past the budget's own dates — only the
                days inside the budget affect its figures.
              </p>
            </div>

            ${table}
            ${heldWarning}
          </div>
        `
    }

    bindHolds(detail) {
        const toggle = this.detailBody.querySelector('#toggle-hold')
        if (toggle) {
            toggle.addEventListener('click', () => {
                this.toggleHold(detail).catch((e) => console.error(e))
            })
        }

        this.detailBody.querySelectorAll('[data-remove-hold]').forEach((button) => {
            button.addEventListener('click', () => {
                this.removeHold(detail, Number(button.dataset.removeHold)).catch((e) =>
                    console.error(e)
                )
            })
        })

        // The detail body is re-rendered wholesale on every refresh, so the
        // previous picker's input no longer exists. Tear it down explicitly —
        // flatpickr leaves its calendar attached to <body>, and an orphaned
        // one would sit over the page with nothing to close it.
        if (this.holdPicker) {
            this.holdPicker.destroy()
            this.holdPicker = null
        }

        const form = this.detailBody.querySelector('#hold-form')
        if (!form) return

        this.editingHold = null
        this.holdRange = { start: '', end: '' }

        this.holdPicker = flatpickr(this.detailBody.querySelector('#hold-range'), {
            mode: 'range',
            dateFormat: 'Y-m-d',
            showMonths: 2,
            // Opens on the budget's own months rather than today's. A hold
            // being recorded after the fact is nearly always inside the
            // budget, which may have started well before now.
            defaultDate: null,
            onOpen: () => {
                this.holdPicker.jumpToDate(this.holdRange.start || detail.start_date)
            },
            onChange: (dates) => {
                this.holdRange.start = dates[0] ? this.toISO(dates[0]) : ''
                this.holdRange.end = dates[1] ? this.toISO(dates[1]) : ''
            },
        })

        this.detailBody
            .querySelector('#add-hold')
            .addEventListener('click', () => this.openHoldForm(detail))

        this.detailBody
            .querySelector('#hold-cancel')
            .addEventListener('click', () => this.closeHoldForm())

        this.detailBody.querySelector('#hold-save').addEventListener('click', () => {
            this.saveHold(detail).catch((e) => console.error(e))
        })

        this.detailBody.querySelectorAll('[data-edit-hold]').forEach((button) => {
            button.addEventListener('click', () => {
                const hold = (detail.holds ?? []).find(
                    (h) => h.id === Number(button.dataset.editHold)
                )
                if (hold) this.openHoldForm(detail, hold)
            })
        })
    }

    /**
     * Reveal the hold form, either empty or loaded with an existing hold.
     *
     * Editing an open-ended hold prefills only its start, so the range you
     * then pick is "when it actually ran" — which is exactly what you're doing
     * when you come back to close off a pause you started weeks ago. Going the
     * other way, turning a closed hold back into an open one, isn't offered:
     * it's "Remove" followed by "Pause from today", and it's rare enough not
     * to be worth a third control.
     */
    openHoldForm(detail, hold = null) {
        const form = this.detailBody.querySelector('#hold-form')
        const reason = this.detailBody.querySelector('#hold-reason')

        this.editingHold = hold?.id ?? null
        this.detailBody.querySelector('#hold-save').textContent = hold
            ? 'Save changes'
            : 'Save hold'

        reason.value = hold?.reason ?? ''

        if (hold?.start_date && hold?.end_date) {
            this.holdRange = { start: hold.start_date, end: hold.end_date }
            this.holdPicker.setDate([hold.start_date, hold.end_date], false)
        } else if (hold?.start_date) {
            this.holdRange = { start: hold.start_date, end: '' }
            this.holdPicker.setDate([hold.start_date], false)
        } else {
            this.holdRange = { start: '', end: '' }
            this.holdPicker.clear()
        }

        form.classList.remove('hidden')
        this.holdPicker.open()
    }

    closeHoldForm() {
        this.editingHold = null
        this.holdRange = { start: '', end: '' }
        if (this.holdPicker) {
            this.holdPicker.clear()
            this.holdPicker.close()
        }
        this.detailBody.querySelector('#hold-reason').value = ''
        this.detailBody.querySelector('#hold-form').classList.add('hidden')
    }

    async saveHold(detail) {
        const { start, end } = this.holdRange
        if (!start || !end) {
            // Checked here rather than left to the server: a range with one end
            // missing is a half-finished click, not a request worth sending.
            this.showToast('Pick the first and last day of the hold.', 'error')
            this.holdPicker.open()
            return
        }

        const reason = this.detailBody.querySelector('#hold-reason').value.trim()
        const body = JSON.stringify({ start_date: start, end_date: end, reason })
        const editing = this.editingHold

        try {
            await this.fetchFromAPI(
                editing
                    ? `/api/budgets/${detail.id}/holds/${editing}`
                    : `/api/budgets/${detail.id}/holds`,
                {
                    method: editing ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                },
                { quiet: true }
            )
            this.showToast(editing ? 'Hold updated' : 'Hold recorded', 'success')
        } catch (error) {
            // Left open with the dates still in it — an overlap or an
            // out-of-range message is something you fix by nudging a date, not
            // by starting again.
            this.showToast(error.message, 'error')
            return
        }

        this.closeHoldForm()
        await this.refreshAfterHoldChange(detail.id)
    }

    /** Today's date as YYYY-MM-DD, local. `toISOString()` would be UTC. */
    static today() {
        const now = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    }

    /**
     * Pause from today, or close the running hold as of yesterday.
     *
     * Resuming ends the hold *yesterday*, not today: you're pressing the button
     * because work is starting again now, so today is a working day. Ending it
     * today would throw away the day you're about to record against.
     *
     * Which means pausing and resuming on the same day would produce a hold
     * ending before it started — no day held at all. That one is deleted
     * instead, because it's a mis-click and leaving a same-day row that
     * excludes nothing just gives the user something to tidy up.
     */
    async toggleHold(detail) {
        const today = Budgets.today()
        const open = (detail.holds ?? []).find((h) => h.end_date == null)

        try {
            if (open) {
                const yesterday = new Date(`${today}T00:00:00`)
                yesterday.setDate(yesterday.getDate() - 1)
                const pad = (n) => String(n).padStart(2, '0')
                const end = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`

                if (end < open.start_date) {
                    // Paused and resumed on the same day: the hold would end
                    // before it began, meaning no day was ever held. That's a
                    // mis-click, not a pause, so it's deleted rather than
                    // clamped into a same-day row that excludes nothing and
                    // has to be tidied up by hand.
                    //
                    // Note this is *only* the zero-day case. Pausing yesterday
                    // and resuming today also lands on end == start, but that
                    // hold really did cover yesterday, so it's kept.
                    await this.fetchFromAPI(
                        `/api/budgets/${detail.id}/holds/${open.id}`,
                        { method: 'DELETE' },
                        { quiet: true }
                    )
                    this.showToast('Hold cancelled — no days were held', 'success')
                } else {
                    await this.fetchFromAPI(
                        `/api/budgets/${detail.id}/holds/${open.id}`,
                        {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ end_date: end }),
                        },
                        { quiet: true }
                    )
                    this.showToast('Project resumed', 'success')
                }
            } else {
                await this.fetchFromAPI(
                    `/api/budgets/${detail.id}/holds`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ start_date: today, end_date: null }),
                    },
                    { quiet: true }
                )
                this.showToast('Project put on hold', 'success')
            }
        } catch (error) {
            this.showToast(error.message, 'error')
            return
        }

        await this.refreshAfterHoldChange(detail.id)
    }

    async removeHold(detail, holdId) {
        try {
            await this.fetchFromAPI(
                `/api/budgets/${detail.id}/holds/${holdId}`,
                { method: 'DELETE' },
                { quiet: true }
            )
            this.showToast('Hold removed', 'success')
        } catch (error) {
            this.showToast(error.message, 'error')
            return
        }

        await this.refreshAfterHoldChange(detail.id)
    }

    /**
     * Reload the open detail view and the page behind it.
     *
     * Wholesale, like every other reload here. A hold changes the capacity this
     * budget consumes, and the overview totals and the client's other cards are
     * all computed from the same allocation — patching one card would leave the
     * rest quietly stale.
     */
    async refreshAfterHoldChange(budgetId) {
        await this.load()
        if (this.detailId === budgetId) await this.openDetail(budgetId)
    }

    diagnosisInsight(budget) {
        if (budget.status === 'at_risk') {
            return `At risk because the current pace projects ${hours(budget.projected_hours)} hrs (${percent(budget.projected_percent)} of the ${hours(budget.budgeted_hours)}-hr commitment), ${hours(budget.projected_overage)} hrs over. This budget's threshold is ${hours(budget.risk_threshold_percent)}% over.`
        }
        if (budget.status === 'over') {
            return `Over budget because ${hours(budget.used_hours)} hrs have already been used against ${hours(budget.budgeted_hours)} committed, ${hours(budget.over_by)} hrs over.`
        }
        return null
    }

    insightIcon(insight, label) {
        return `
          <button type="button" class="tk-insight" data-insight="${insight}"
                  aria-label="${label}: ${insight}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 11v5M12 8h.01"></path>
            </svg>
          </button>
        `
    }

    insightLabel(label, insight) {
        return `
          <div class="tk-stat-label flex items-center gap-1">
            ${label}
            ${this.insightIcon(insight, label)}
          </div>
        `
    }

    detailStat(label, value, sub, insight = null) {
        return `
          <div class="bg-surface px-3 py-2.5">
            ${insight ? this.insightLabel(label, insight) : `<div class="tk-stat-label">${label}</div>`}
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
                `<option value="none">No budget</option>`,
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
              ${entry.held ? '<span class="tk-badge tk-badge-warn ml-1.5" title="Recorded on a day this project was on hold. It still counts — the hold dates may need correcting.">on hold</span>' : ''}
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

    unassignedEntriesTable(detail) {
        if (!detail.unassigned_entries.length) {
            return '<div class="tk-empty py-6">No client time has been explicitly left without a budget.</div>'
        }

        const options = () => [
            '<option value="">Auto (bucket fill)</option>',
            '<option value="none" selected>No budget</option>',
            ...detail.sibling_budgets.map(
                (b) => `<option value="${b.id}">${this.escapeHtml(b.name)}</option>`
            ),
        ].join('')

        const rows = detail.unassigned_entries.map((entry) => `
          <tr>
            <td class="tk-num whitespace-nowrap">${shortDate(entry.date)}</td>
            <td class="tk-num whitespace-nowrap text-muted">
              ${entry.start_time ?? '—'}${entry.end_time ? `–${entry.end_time}` : ''}
              ${entry.running ? '<span class="tk-badge tk-badge-accent ml-1.5">running</span>' : ''}
            </td>
            <td class="tk-num text-right font-medium">${hours(entry.hours)}</td>
            <td class="w-px">
              <select class="tk-select tk-select-sm w-44" data-task-id="${entry.task_id}"
                      aria-label="Budget for this entry">${options()}</select>
            </td>
          </tr>
        `).join('')

        return `
          <div class="overflow-hidden rounded-lg border border-border">
            <table class="tk-table tk-table-hover">
              <thead><tr><th>Date</th><th>Time</th><th class="text-right">Hours</th><th>Assigned to</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `
    }

    bindEntryPins(detail) {
        this.detailBody.querySelectorAll('[data-task-id]').forEach((select) => {
            select.addEventListener('change', async () => {
                const taskId = Number(select.dataset.taskId)
                const value = select.value === 'none'
                    ? 'none'
                    : (select.value ? Number(select.value) : null)
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
                        value === 'none'
                            ? 'Entry left without a budget'
                            : (value ? 'Entry pinned to that budget' : 'Entry released to the allocator'),
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
     *
     * Held days are flat for the same reason and are shaded behind the lines.
     * Without the shading a three-week pause shows as a long flat stretch in
     * both series and reads as a rendering fault; with it, it reads as the
     * fact it is.
     */
    drawBurnChart(detail) {
        const canvas = document.getElementById('burn-chart')
        if (!canvas || typeof Chart === 'undefined') return

        if (this.chart) this.chart.destroy()

        const css = getComputedStyle(document.documentElement)
        const token = (name) => css.getPropertyValue(name).trim()

        const overBudget = detail.status === 'over'

        // A tiny inline plugin rather than an annotation library: the whole job
        // is painting grey rectangles between two x positions, and adding a
        // dependency to the bundle for that would be a poor trade.
        const holdBands = {
            id: 'holdBands',
            beforeDatasetsDraw(chart) {
                const spans = []
                detail.burn.forEach((point, index) => {
                    if (!point.held) return
                    const last = spans[spans.length - 1]
                    if (last && last.end === index - 1) last.end = index
                    else spans.push({ start: index, end: index })
                })
                if (!spans.length) return

                const { ctx, chartArea, scales } = chart
                // Half the gap between two adjacent days, measured off the
                // scale rather than assumed, so the band covers the days
                // themselves rather than stopping on their gridlines.
                const half =
                    detail.burn.length > 1
                        ? (scales.x.getPixelForValue(1) - scales.x.getPixelForValue(0)) / 2
                        : 0

                ctx.save()
                ctx.fillStyle = token('--surface-3')
                spans.forEach(({ start, end }) => {
                    const left = Math.max(chartArea.left, scales.x.getPixelForValue(start) - half)
                    const right = Math.min(chartArea.right, scales.x.getPixelForValue(end) + half)
                    if (right > left) {
                        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top)
                    }
                })
                ctx.restore()
            },
        }

        this.chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            plugins: [holdBands],
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
                            // Said in the tooltip as well as the shading: the
                            // bands are readable at a glance but ambiguous at
                            // the edges, and the edges are what people check.
                            afterBody: (items) =>
                                detail.burn[items[0]?.dataIndex]?.held ? 'On hold' : undefined,
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
        this.detailCloseBudget.addEventListener('click', () => {
            this.closeBudget().catch((e) => console.error(e))
        })

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

    bindInsights() {
        this.insightPopover = document.createElement('div')
        this.insightPopover.className = 'tk-insight-popover hidden'
        this.insightPopover.setAttribute('role', 'tooltip')
        document.body.appendChild(this.insightPopover)

        const show = (target) => {
            this.insightPopover.textContent = target.dataset.insight
            this.insightPopover.classList.remove('hidden')

            const anchor = target.getBoundingClientRect()
            const tip = this.insightPopover.getBoundingClientRect()
            let left = anchor.left + anchor.width / 2 - tip.width / 2
            left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8))
            let top = anchor.top - tip.height - 8
            if (top < 8) top = anchor.bottom + 8

            this.insightPopover.style.left = `${left}px`
            this.insightPopover.style.top = `${top}px`
        }
        const hide = () => this.insightPopover.classList.add('hidden')

        document.addEventListener('mouseover', (event) => {
            const target = event.target.closest?.('.tk-insight')
            if (target) show(target)
        })
        document.addEventListener('mouseout', (event) => {
            const target = event.target.closest?.('.tk-insight')
            if (target && !target.contains(event.relatedTarget)) hide()
        })
        document.addEventListener('focusin', (event) => {
            const target = event.target.closest?.('.tk-insight')
            if (target) show(target)
        })
        document.addEventListener('focusout', (event) => {
            if (event.target.closest?.('.tk-insight')) hide()
        })
        document.addEventListener('click', (event) => {
            const target = event.target.closest?.('.tk-insight')
            if (!target) {
                hide()
                return
            }
            event.preventDefault()
            event.stopPropagation()
            show(target)
        })
        document.addEventListener('scroll', hide, true)
        window.addEventListener('resize', hide)
    }

    showModal(modal) {
        if (!modal.classList.contains('hidden')) return
        modal.classList.remove('hidden')
        lockBodyScroll()
    }

    hideModal(modal, { reopenDetail = true } = {}) {
        if (!modal || modal.classList.contains('hidden')) return
        modal.classList.add('hidden')
        unlockBodyScroll()

        if (modal === this.formModal) {
            const returnBudgetId = this.formReturnBudgetId
            this.formReturnBudgetId = null
            this.editing = null
            this.deleteButton.classList.remove('tk-btn-danger-armed')
            this.deleteButton.textContent = 'Delete'

            // X, Cancel, backdrop click, and Escape all come through here.
            // Restore the budget they were editing without making each close
            // control maintain its own copy of the transition logic.
            if (reopenDetail && returnBudgetId) {
                this.openDetail(returnBudgetId).catch((e) => console.error(e))
            }
        }
        if (modal === this.detailModal) {
            this.resetCloseBudgetButton()
            this.detailId = null
            this.detail = null
            if (this.chart) {
                this.chart.destroy()
                this.chart = null
            }
            // flatpickr mounts its calendar on <body>, not next to the input,
            // so closing the modal isn't enough to take it away — an open
            // picker would be left floating over the page with nothing left to
            // close it.
            if (this.holdPicker) {
                this.holdPicker.destroy()
                this.holdPicker = null
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
