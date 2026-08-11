import { reconcileChildren, setHtml } from './base.js'
import {
    STATUS_LABEL,
    budgetDuration,
    headline,
    insightIconInline,
    meter,
    percent,
    policyHours,
    shortDate,
    statusInsight,
} from './budget_render.js'

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

        // Patched in place rather than rebuilt: this reloads every minute while
        // a task runs, and a wholesale innerHTML swap took the keyboard focus
        // off a strip the user had tabbed to and detached the meter a popover
        // was anchored against. Only the figures actually move.
        reconcileChildren(this.list, budgets, {
            key: (budget) => budget.id,
            create: (budget) => {
                const strip = document.createElement('a')
                strip.className = 'tk-budget-strip block no-underline'
                strip.title = 'Open this budget in Budgets'
                this.updateStrip(strip, budget)
                return strip
            },
            update: ([strip], budget) => this.updateStrip(strip, budget),
        })

        this.container.classList.remove('hidden')
    }

    updateStrip(strip, budget) {
        const href = `/budgets?budget_id=${encodeURIComponent(budget.id)}`
        if (strip.getAttribute('href') !== href) strip.setAttribute('href', href)
        if (strip.dataset.status !== budget.status) strip.dataset.status = budget.status
        setHtml(strip, this.strip(budget))
    }

    strip(budget) {
        // The whole point of this widget is the glance, so the layout is one
        // line of identity, one bar, one line of consequence.
        //
        // That bar is the same one the Budgets cards draw, period marker
        // included. The marker was suppressed here while it was a faint
        // hairline that only added noise at this size; drawn clearly it earns
        // its place, because it is the one thing that makes "62% used" mean
        // anything without reading a second number.
        //
        // Returns the *contents* of the strip; the anchor itself is created
        // once and reused across refreshes by updateStrip.
        return `
            <div class="mb-1.5 flex items-baseline justify-between gap-2">
              <span class="min-w-0 truncate text-sm font-semibold text-text">${this.escape(budget.name)}</span>
              <span class="tabular flex-shrink-0 text-sm font-semibold" style="color: var(--status-text)">
                ${percent(budget.percent_used_exact ?? budget.percent_used)} used
              </span>
            </div>

            ${meter(budget, { large: true })}

            <!-- items-center, not items-baseline: the right-hand side is text
                 for one status, a badge for another and either of those plus a
                 circled-i, and an icon has no baseline worth aligning to. The
                 identity row above is two pieces of text and keeps its. -->
            <div class="mt-1.5 flex items-center justify-between gap-2 text-xs">
              <span class="tabular text-muted">
                ${budgetDuration(budget, 'used_hours', 'used_seconds', { exact: budget.status === 'over' })} / ${policyHours(budget.budgeted_hours)} hrs.
                <span class="text-faint">· to ${shortDate(budget.end_date)}</span>
              </span>
              <span class="flex flex-shrink-0 items-center gap-1.5 text-right" style="color: var(--status-text)">
                ${
                    budget.status === 'at_risk' || budget.status === 'over'
                        ? `<span class="tk-badge tk-badge-status">${budget.status === 'over' ? 'Over budget' : 'Pace at risk'}</span>`
                        : budget.status === 'on_track'
                        ? this.escape(`${budgetDuration(budget, 'remaining_hours', 'remaining_seconds', { floorAtZero: true })} left`)
                        // The full paused headline carries dates and a resume
                        // date and is far too long for one line here. On this
                        // screen the useful fact is just that you're about to
                        // record time against a project that's supposed to be
                        // stopped; the Budgets page has the rest.
                        : budget.status === 'paused'
                          ? this.escape(`On hold · ${budgetDuration(budget, 'remaining_hours', 'remaining_seconds', { floorAtZero: true })} left`)
                          : this.escape(headline(budget))
                }
                ${this.statusIcon(budget)}
              </span>
            </div>
        `
    }

    /**
     * The circled-i that opens the status breakdown.
     *
     * The consequence line used to *be* the hover target — the words "6.5 hrs.
     * left" carried the popover themselves, with a dotted underline as the only
     * hint. Nothing else in the app asks you to discover a tooltip by hovering
     * prose: every other explanation in Budgets, Settings and Summary hangs off
     * a circled-i placed after the label it explains. So the text is now just
     * text and the icon is the trigger, which also means the whole strip reads
     * as a link again, with one small exception in it rather than two.
     *
     * `insightIconInline` rather than `insightIcon` because the strip is an
     * anchor — see the note on that helper.
     */
    statusIcon(budget) {
        const body = statusInsight(budget)
        if (!body) return ''
        return insightIconInline(body, 'Status breakdown')
    }

    escape(value) {
        const div = document.createElement('div')
        div.textContent = value == null ? '' : String(value)
        return div.innerHTML
    }
}

export { STATUS_LABEL }
