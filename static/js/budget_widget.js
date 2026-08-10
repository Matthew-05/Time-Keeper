import { STATUS_LABEL, headline, hours, meter, percent, shortDate } from './budget_render.js'

/**
 * The Today page's budget strip.
 *
 * Scoped to whichever client the running task is on, so it answers the one
 * question the dashboard should be able to answer without navigating: *is the
 * time I am recording right now going to blow something?*
 *
 * Only budgets currently in force are shown, and the server does that filtering
 * — the dashboard should never pull down a client's whole budget history to
 * draw two bars. A client with none renders nothing at all rather than an empty
 * state, because "no budget" is the normal condition for most work and a
 * permanent empty box would be noise on the app's busiest screen.
 *
 * Deliberately mirrors WorksList's shape (`setTarget` / `showPending` / `clear`)
 * so the dashboard drives both through one code path and they can't end up
 * pointed at different clients.
 */
export class BudgetWidget {
    constructor({ container, list, api }) {
        this.container = container
        this.list = list
        this.api = api

        this.clientId = null
        // Guards a slow response from painting over a newer target — the same
        // race works.js documents at length.
        this.loadToken = 0
    }

    /** Point at a client and reload. Null hides the widget entirely. */
    setTarget(clientId) {
        this.clientId = clientId

        if (clientId == null) {
            this.clear()
            return
        }

        this.load().catch((error) => console.error('Budget widget failed:', error))
    }

    /**
     * Waiting on a client id.
     *
     * Stays hidden rather than showing a spinner: the dashboard reveals this
     * before it knows the client, and most clients have no budget, so a
     * skeleton here would flash on every page load and resolve to nothing.
     */
    showPending() {
        this.clientId = null
        this.loadToken++
        this.container.classList.add('hidden')
    }

    clear() {
        this.clientId = null
        this.loadToken++
        this.container.classList.add('hidden')
        this.list.innerHTML = ''
    }

    /** Re-fetch for the current client. Called after a task is completed. */
    async refresh() {
        if (this.clientId == null) return
        await this.load()
    }

    async load() {
        const token = ++this.loadToken
        const clientId = this.clientId

        let budgets
        try {
            budgets = await this.api.fetchFromAPI(`/api/budgets/for-client/${clientId}`)
        } catch (error) {
            // Leave whatever is on screen. A stale meter for a moment beats the
            // widget vanishing mid-task, and reads retry themselves.
            console.error('Could not load budgets for this client:', error)
            return
        }

        if (token !== this.loadToken || clientId !== this.clientId) return

        if (!budgets.length) {
            this.container.classList.add('hidden')
            this.list.innerHTML = ''
            return
        }

        this.list.innerHTML = budgets.map((b) => this.strip(b)).join('')
        this.container.classList.remove('hidden')
    }

    strip(budget) {
        // The whole point of this widget is the glance, so the layout is one
        // line of identity, one bar, one line of consequence.
        return `
          <a href="/budgets?budget_id=${encodeURIComponent(budget.id)}"
             class="tk-budget-strip block no-underline" data-status="${budget.status}"
             title="Open this budget in Budgets">
            <div class="mb-1.5 flex items-baseline justify-between gap-2">
              <span class="min-w-0 truncate text-sm font-semibold text-text">${this.escape(budget.name)}</span>
              <span class="tabular flex-shrink-0 text-sm font-semibold" style="color: var(--status-text)">
                ${percent(budget.percent_used)} used
              </span>
            </div>

            ${meter(budget, { showPeriodMarker: false })}

            <div class="mt-1.5 flex items-baseline justify-between gap-2 text-xs">
              <span class="tabular text-muted">
                ${hours(budget.used_hours)} / ${hours(budget.budgeted_hours)} hrs.
                <span class="text-faint">· to ${shortDate(budget.end_date)}</span>
              </span>
              <span class="flex-shrink-0 text-right" style="color: var(--status-text)">
                ${
                    budget.status === 'at_risk' || budget.status === 'over'
                        ? this.warningBadge(budget)
                        : budget.status === 'on_track'
                        ? this.escape(`${hours(budget.remaining_hours)} hrs. left`)
                        // The full paused headline carries dates and a resume
                        // date and is far too long for one line here. On this
                        // screen the useful fact is just that you're about to
                        // record time against a project that's supposed to be
                        // stopped; the Budgets page has the rest.
                        : budget.status === 'paused'
                          ? this.escape(`On hold · ${hours(budget.remaining_hours)} hrs. left`)
                          : this.escape(headline(budget))
                }
              </span>
            </div>
          </a>
        `
    }

    warningBadge(budget) {
        const label = budget.status === 'over' ? 'Over budget' : 'Pace at risk'
        const detail = headline(budget)

        return `<span class="tk-badge tk-badge-status tk-insight tk-budget-warning"
                      data-insight="${this.escape(detail)}"
                      aria-label="${this.escape(`${label}: ${detail}`)}">${label}</span>`
    }

    escape(value) {
        const div = document.createElement('div')
        div.textContent = value == null ? '' : String(value)
        return div.innerHTML
    }
}

export { STATUS_LABEL }
