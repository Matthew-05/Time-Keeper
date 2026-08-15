import {
    TimeKeeper,
    ready,
    createChoices,
    confirmAction,
    disarmConfirm,
    makeModalBackdropStatic,
    lockBodyScroll,
    unlockBodyScroll,
} from './base.js'
import {
    dateRange,
    detailDateRange,
    exactDurationSeconds,
    hours,
    percent,
    shortDate,
    withHours,
} from './budget_render.js'
import { flatpickrCalendarOptions } from './week_start.js'


export const TEAM_STATUS_LABEL = {
    on_track: 'Within budget',
    at_risk: 'At risk',
    over: 'Over budget',
    upcoming: 'Upcoming',
    closed: 'Closed',
}


export function importChoiceErrors(preview, mappings, rangeAction) {
    const errors = []
    if (!preview || preview.row_count < 1) errors.push('No importable rows were found.')
    if (preview?.validation_error_count) errors.push('Fix invalid workbook rows first.')
    for (const sourceId of preview?.unknown_user_ids || []) {
        const choice = mappings[sourceId]
        if (!choice || !['existing', 'new'].includes(choice.action)) {
            errors.push(`Choose where ${sourceId} belongs.`)
        } else if (choice.action === 'existing' && !Number(choice.member_id)) {
            errors.push(`Choose an existing member for ${sourceId}.`)
        } else if (choice.action === 'new' && !(Number(choice.budgeted_hours) > 0)) {
            errors.push(`Enter budgeted hours for ${sourceId}.`)
        }
    }
    if (preview?.out_of_range_row_count && !['adjust', 'skip'].includes(rangeAction)) {
        errors.push('Choose how to handle dates outside the budget period.')
    }
    return errors
}


export function teamBudgetMatchesFilter(budget, filter) {
    if (filter === 'all') return true
    return filter === 'closed' ? Boolean(budget.is_closed) : !budget.is_closed
}


export function teamBudgetDetailScope(detail, memberId) {
    if (!memberId) return null
    return detail?.members?.find((member) => String(member.id) === String(memberId)) || null
}


class TeamBudgets extends TimeKeeper {
    constructor() {
        super()
        this.personalView = document.getElementById('personal-budgets-view')
        this.teamView = document.getElementById('team-budgets-view')
        this.tabs = [...document.querySelectorAll('[data-budget-view]')]
        this.personalNew = document.getElementById('new-budget')
        this.teamNew = document.getElementById('new-team-budget')
        this.subtitle = document.getElementById('budgets-subtitle')

        this.list = document.getElementById('team-budget-list')
        this.overview = document.getElementById('team-budgets-overview')
        this.statusFilter = document.getElementById('team-status-filter')
        this.clientFilter = document.getElementById('team-client-filter')

        this.formModal = document.getElementById('team-budget-form-modal')
        this.form = document.getElementById('team-budget-form')
        this.formTitle = document.getElementById('team-budget-form-title')
        this.saveButton = document.getElementById('team-budget-save')
        this.deleteButton = document.getElementById('team-budget-delete')
        this.startXlsxPanel = document.getElementById('team-budget-xlsx-start')
        this.startXlsxButton = document.getElementById('team-budget-start-xlsx')
        this.startFileSummary = document.getElementById('team-budget-start-file-summary')
        this.memberRows = document.getElementById('team-member-rows')
        this.fields = {
            name: document.getElementById('team-budget-name'),
            client: document.getElementById('team-budget-client'),
            range: document.getElementById('team-budget-range'),
            notes: document.getElementById('team-budget-notes'),
        }

        this.detailModal = document.getElementById('team-budget-detail-modal')
        this.detailTitle = document.getElementById('team-budget-detail-title')
        this.detailRange = document.getElementById('team-budget-detail-range')
        this.detailBody = document.getElementById('team-budget-detail-body')
        this.detailEdit = document.getElementById('team-budget-edit')
        this.detailImport = document.getElementById('team-budget-import')

        this.importModal = document.getElementById('team-import-modal')
        this.importTitle = document.getElementById('team-import-title')
        this.importSubtitle = document.getElementById('team-import-subtitle')
        this.importForm = document.getElementById('team-import-form')
        this.importFile = document.getElementById('team-import-file')
        this.importFileButton = document.getElementById('team-import-file-button')
        this.importTimeFormat = document.getElementById('team-import-time-format')
        this.importColumns = document.getElementById('team-import-columns')
        this.importSheet = document.getElementById('team-import-sheet')
        this.importDateColumn = document.getElementById('team-import-date-column')
        this.importUserColumn = document.getElementById('team-import-user-column')
        this.importTimeColumn = document.getElementById('team-import-time-column')
        this.importPreviewPanel = document.getElementById('team-import-preview')
        this.importSummary = document.getElementById('team-import-summary')
        this.importErrors = document.getElementById('team-import-errors')
        this.importUsers = document.getElementById('team-import-users')
        this.importUsersHelp = document.getElementById('team-import-users-help')
        this.importUserRows = document.getElementById('team-import-user-rows')
        this.importRangeChoice = document.getElementById('team-import-range-choice')
        this.importOutsideDates = document.getElementById('team-import-outside-dates')
        this.previewButton = document.getElementById('team-import-preview-button')
        this.confirmImportButton = document.getElementById('team-import-confirm')

        this.budgets = []
        this.filter = 'active'
        this.range = { start: '', end: '' }
        this.editing = null
        this.detail = null
        this.detailId = null
        this.importReturnDetailId = null
        this.preview = null
        this.columnMapping = null
        this.importBudgetId = null
        this.importDetail = null
        this.importMode = 'existing'
        this.returnToTeamForm = false
        this.startingImport = null
        this.chart = null
        this.detailMemberId = ''
        this.detailMemberPicker = null
        this.detailFilterObserver = null
        this.entryPage = 1
        this.loadToken = 0
    }

    async init() {
        this.initializePickers()
        this.bindTabs()
        this.bindForm()
        this.bindDetail()
        this.bindImport()
        this.bindModals()
        this.bindTheme()
        await this.load()
        const params = new URLSearchParams(window.location.search)
        const initialView = params.get('view') === 'team' ? 'team' : 'personal'
        this.selectView(initialView, false)
        const linkedId = Number(params.get('team_budget_id'))
        if (initialView === 'team' && linkedId) await this.openDetail(linkedId)
    }

    initializePickers() {
        const options = {
            searchPlaceholderValue: 'Start typing client name...',
            searchResultLimit: 10,
            shouldSort: false,
            itemSelectText: '',
        }
        this.clientFilterPicker = createChoices(this.clientFilter, {
            ...options,
            placeholder: true,
            placeholderValue: 'All clients',
        })
        this.clientPicker = createChoices(this.fields.client, {
            ...options,
            placeholder: true,
            placeholderValue: 'Choose a client…',
        })
        this.rangePicker = flatpickr(this.fields.range, flatpickrCalendarOptions({
            mode: 'range',
            dateFormat: 'Y-m-d',
            showMonths: 2,
            onOpen: () => {
                if (this.range.start) this.rangePicker.jumpToDate(this.range.start)
            },
            onChange: (selectedDates) => {
                if (selectedDates.length !== 2) return
                this.range.start = this.toISO(selectedDates[0])
                this.range.end = this.toISO(selectedDates[1])
            },
            onClose: (selectedDates) => {
                if (selectedDates.length === 1) {
                    this.rangePicker.setDate([selectedDates[0], selectedDates[0]], true)
                }
            },
        }))
    }

    bindTabs() {
        this.tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => this.selectView(tab.dataset.budgetView))
            tab.addEventListener('keydown', (event) => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
                event.preventDefault()
                const direction = event.key === 'ArrowRight' ? 1 : -1
                const target = this.tabs[(index + direction + this.tabs.length) % this.tabs.length]
                this.selectView(target.dataset.budgetView)
                target.focus()
            })
        })
        this.clientFilter.addEventListener('change', () => this.render())
        this.statusFilter.addEventListener('click', (event) => {
            const button = event.target.closest('[data-team-filter]')
            if (!button) return
            this.filter = button.dataset.teamFilter
            this.statusFilter.querySelectorAll('[data-team-filter]').forEach((item) => {
                const selected = item === button
                item.classList.toggle('active', selected)
                item.setAttribute('aria-checked', String(selected))
            })
            this.render()
        })
    }

    selectView(view, updateUrl = true) {
        const team = view === 'team'
        this.personalView.classList.toggle('hidden', team)
        this.teamView.classList.toggle('hidden', !team)
        this.personalNew.classList.toggle('hidden', team)
        this.teamNew.classList.toggle('hidden', !team)
        this.subtitle.textContent = team
            ? 'Team workspace · manually imported engagement history.'
            : 'Personal workspace · time tracked in Time Keeper.'
        this.tabs.forEach((tab) => {
            const selected = tab.dataset.budgetView === (team ? 'team' : 'personal')
            tab.classList.toggle('active', selected)
            tab.setAttribute('aria-selected', String(selected))
            tab.tabIndex = selected ? 0 : -1
        })
        if (updateUrl) {
            const url = new URL(window.location.href)
            if (team) url.searchParams.set('view', 'team')
            else url.searchParams.delete('view')
            history.replaceState(null, '', url)
        }
        document.dispatchEvent(new CustomEvent('budgetViewChanged', {
            detail: { view: team ? 'team' : 'personal' },
        }))
    }

    async load() {
        const token = ++this.loadToken
        try {
            const budgets = await this.fetchFromAPI('/api/team-budgets')
            if (token !== this.loadToken) return
            this.budgets = budgets
            this.render()
        } catch (error) {
            if (token !== this.loadToken) return
            this.list.innerHTML = '<div class="tk-card tk-empty py-10">Reconnecting…</div>'
            setTimeout(() => this.load().catch(console.error), 3000)
        }
    }

    visible() {
        const clientId = this.clientFilter.value
        return this.budgets.filter((budget) => {
            const clientMatches = !clientId || String(budget.client_id) === clientId
            const statusMatches = teamBudgetMatchesFilter(budget, this.filter)
            return clientMatches && statusMatches
        })
    }

    render() {
        const active = this.budgets.filter((budget) => budget.is_active)
        this.overview.classList.toggle('hidden', !this.budgets.length)
        if (this.budgets.length) {
            document.getElementById('team-overview-count').textContent = active.length
            document.getElementById('team-overview-budgeted').textContent =
                hours(active.reduce((sum, budget) => sum + budget.budgeted_hours, 0))
            document.getElementById('team-overview-used').textContent =
                hours(active.reduce((sum, budget) => sum + budget.used_hours, 0))
            document.getElementById('team-overview-risk').textContent =
                active.filter((budget) => ['at_risk', 'over'].includes(budget.status)).length
        }

        const visible = this.visible()
        if (!visible.length) {
            this.list.innerHTML = this.budgets.length
                ? '<div class="tk-card tk-empty py-10">No team budgets match these filters.</div>'
                : '<div class="tk-card tk-empty py-10">No team budgets yet. Create one, add its members, then import the engagement workbook.</div>'
            return
        }
        this.list.innerHTML = visible.map((budget) => this.card(budget)).join('')
        this.list.querySelectorAll('[data-team-budget-id]').forEach((card) => {
            card.addEventListener('click', () => this.openDetail(Number(card.dataset.teamBudgetId)))
        })
    }

    card(budget) {
        const used = Math.min(100, Math.max(0, budget.percent_used || 0))
        const status = TEAM_STATUS_LABEL[budget.status] || budget.status
        const projection = budget.projection_as_of
            ? `Projection ${hours(budget.projected_hours)} hrs. as of ${shortDate(budget.projection_as_of)}`
            : 'Import team time to establish a projection'
        return `
          <button type="button" class="tk-budget-card is-clickable w-full p-5 text-left" data-status="${budget.status}" data-team-budget-id="${budget.id}">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0"><div class="truncate text-sm font-semibold text-text">${this.escapeHtml(budget.name)}</div><div class="mt-0.5 text-xs text-muted">${this.escapeHtml(budget.client_name || 'Removed client')} · ${dateRange(budget)}</div></div>
              <span class="tk-badge" style="color:var(--status-text);background:var(--status-soft)">${status}</span>
            </div>
            <div class="mt-4 tk-meter"><div class="tk-meter-fill" style="width:${used}%"></div></div>
            <div class="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted"><span>${hours(budget.used_hours)} of ${hours(budget.budgeted_hours)} hrs. imported</span><span>${percent(budget.percent_used)}</span></div>
            <div class="mt-3 flex flex-wrap justify-between gap-2 text-xs text-faint"><span>${this.escapeHtml(projection)}</span><span>${budget.members.length} member${budget.members.length === 1 ? '' : 's'} · ${budget.entry_count} row${budget.entry_count === 1 ? '' : 's'}</span></div>
          </button>`
    }

    bindForm() {
        this.teamNew.addEventListener('click', () => this.openForm())
        this.startXlsxButton.addEventListener('click', () => this.openStartingImport())
        document.getElementById('team-member-add').addEventListener('click', () => {
            this.addMemberRow()
        })
        this.memberRows.addEventListener('click', (event) => {
            const remove = event.target.closest('[data-remove-team-member]')
            if (remove && !remove.disabled) remove.closest('[data-team-member-row]').remove()
        })
        this.form.addEventListener('submit', (event) => {
            event.preventDefault()
            this.submit().catch(console.error)
        })
        this.deleteButton.addEventListener('click', () => {
            if (!this.editing) return
            confirmAction(this.deleteButton, () => this.remove())
        })
    }

    addMemberRow(member = null) {
        const row = document.createElement('div')
        row.className = 'grid gap-2 rounded-lg border border-border bg-surface-2 p-3 sm:grid-cols-[1fr_1fr_9rem_auto]'
        row.dataset.teamMemberRow = ''
        if (member?.id) row.dataset.memberId = member.id
        const locked = member && member.used_hours > 0
        row.innerHTML = `
          <label class="text-xs text-muted">Imported user ID<input class="tk-input mt-1" data-member-source required maxlength="200" /></label>
          <label class="text-xs text-muted">Display name <span class="text-faint">(optional)</span><input class="tk-input mt-1" data-member-name maxlength="120" /></label>
          <label class="text-xs text-muted">Budgeted hours<input type="number" class="tk-input mt-1 tabular" data-member-hours required min="0.01" step="0.01" /></label>
          <button type="button" class="tk-btn-icon tk-btn-icon-sm self-end" data-remove-team-member aria-label="Remove member" title="${locked ? 'Members with imported time cannot be removed until replacement data is imported.' : 'Remove member'}" ${locked ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14" /></svg>
          </button>`
        row.querySelector('[data-member-source]').value = member?.source_user_id || ''
        row.querySelector('[data-member-name]').value = member?.display_name || ''
        row.querySelector('[data-member-hours]').value = member?.budgeted_hours ?? ''
        this.memberRows.appendChild(row)
    }

    collectMembers() {
        return [...this.memberRows.querySelectorAll('[data-team-member-row]')].map((row) => ({
            ...(row.dataset.memberId ? { id: Number(row.dataset.memberId) } : {}),
            source_user_id: row.querySelector('[data-member-source]').value.trim(),
            display_name: row.querySelector('[data-member-name]').value.trim(),
            budgeted_hours: Number(row.querySelector('[data-member-hours]').value),
        }))
    }

    openForm(budget = null) {
        this.editing = budget
        this.startXlsxPanel.classList.toggle('hidden', Boolean(budget))
        if (!budget) {
            this.startingImport = null
            this.renderStartingImportSummary()
        }
        if (budget && !this.detailModal.classList.contains('hidden')) this.hideModal(this.detailModal)
        this.formTitle.textContent = budget ? 'Edit team budget' : 'New team budget'
        this.saveButton.textContent = budget ? 'Save changes' : 'Create team budget'
        this.deleteButton.classList.toggle('hidden', !budget)
        this.fields.name.value = budget?.name || ''
        this.fields.notes.value = budget?.notes || ''
        if (budget) this.clientPicker.setChoiceByValue(String(budget.client_id))
        else this.clientPicker.removeActiveItems()

        this.range.start = budget?.start_date || this.toISO(new Date())
        this.range.end = budget?.end_date || this.range.start
        this.rangePicker.setDate([this.range.start, this.range.end], false)
        this.memberRows.innerHTML = ''
        ;(budget?.members || [null]).forEach((member) => this.addMemberRow(member))
        this.showModal(this.formModal)
        this.fields.name.focus()
    }

    async submit() {
        const payload = {
            name: this.fields.name.value.trim(),
            client_id: Number(this.fields.client.value),
            start_date: this.range.start,
            end_date: this.range.end,
            notes: this.fields.notes.value.trim(),
            members: this.collectMembers(),
        }
        this.saveButton.disabled = true
        try {
            let endpoint = this.editing ? `/api/team-budgets/${this.editing.id}` : '/api/team-budgets'
            let options = {
                method: this.editing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }
            if (!this.editing && this.startingImport) {
                endpoint = '/api/team-budgets/from-import'
                const formData = new FormData()
                formData.append('file', this.startingImport.file)
                formData.append('time_format', this.startingImport.timeFormat)
                if (this.startingImport.sheet) formData.append('sheet', this.startingImport.sheet)
                if (this.startingImport.columnMapping) {
                    formData.append('column_mapping', JSON.stringify(this.startingImport.columnMapping))
                }
                formData.append('budget', JSON.stringify(payload))
                options = { method: 'POST', body: formData }
            }
            const saved = await this.fetchFromAPI(
                endpoint,
                options,
                { quiet: true, timeout: this.startingImport ? 60000 : undefined },
            )
            const wasEditing = Boolean(this.editing)
            const importedRows = this.startingImport ? saved.import_row_count : 0
            this.startingImport = null
            this.hideModal(this.formModal)
            this.showToast(
                wasEditing
                    ? 'Team budget updated'
                    : importedRows
                        ? `Team budget created with ${importedRows} imported row${importedRows === 1 ? '' : 's'}`
                        : 'Team budget created',
                'success',
            )
            await this.load()
            if (wasEditing) await this.openDetail(saved.id)
        } catch (error) {
            this.showToast(error.message, 'error')
        } finally {
            this.saveButton.disabled = false
        }
    }

    async remove() {
        const id = this.editing?.id
        if (!id) return
        try {
            await this.fetchFromAPI(`/api/team-budgets/${id}`, { method: 'DELETE' }, { quiet: true })
            this.hideModal(this.formModal)
            this.showToast('Team budget and its imported history were deleted.', 'success')
            await this.load()
        } catch (error) {
            this.showToast(error.message, 'error')
        }
    }

    bindDetail() {
        this.detailEdit.addEventListener('click', () => {
            if (this.detail) this.openForm(this.detail)
        })
        this.detailImport.addEventListener('click', () => {
            if (this.detail) this.openImport(this.detail)
        })
        this.detailBody.addEventListener('change', (event) => {
            if (event.target.id === 'team-detail-member-filter') this.applyDetailMemberFilter()
        })
        this.detailBody.addEventListener('click', (event) => {
            const clearFilter = event.target.closest('#team-detail-member-clear')
            if (clearFilter) {
                this.detailMemberPicker?.removeActiveItems()
                const filter = document.getElementById('team-detail-member-filter')
                if (filter) filter.value = ''
                this.applyDetailMemberFilter()
                return
            }
            const pageButton = event.target.closest('[data-team-entry-page]')
            if (pageButton) this.loadEntries(Number(pageButton.dataset.teamEntryPage))
        })
    }

    async openDetail(id) {
        this.destroyDetailFilter()
        this.detailId = id
        this.detailMemberId = ''
        this.detailTitle.textContent = 'Team budget'
        this.detailRange.textContent = ''
        this.detailBody.innerHTML = '<div class="tk-empty py-10">Loading…</div>'
        this.showModal(this.detailModal)
        try {
            const detail = await this.fetchFromAPI(`/api/team-budgets/${id}`)
            if (this.detailId !== id) return
            this.detail = detail
            this.renderDetail(detail)
            await this.loadEntries(1)
        } catch (error) {
            if (this.detailId === id) this.detailBody.innerHTML = '<div class="tk-empty py-10">Could not load this team budget.</div>'
        }
    }

    renderDetail(detail) {
        this.detailTitle.textContent = detail.name
        this.detailRange.textContent = `${detail.client_name} · ${detailDateRange(detail)}`
        this.detailBody.innerHTML = `
          <div id="team-detail-filter-sentinel" class="tk-team-detail-filter-sentinel" aria-hidden="true"></div>
          <section id="team-detail-filter" class="tk-card tk-team-detail-filter" aria-label="Team budget employee view">
            <div class="tk-team-detail-filter-inner">
              <div class="min-w-0">
                <div class="tk-label mb-0">Employee view</div>
                <p class="mt-1 text-xs text-faint">Filters every report section in this budget.</p>
              </div>
              <div class="tk-summary-client-filter">
                <label for="team-detail-member-filter" class="sr-only">Filter team budget by employee</label>
                <div class="tk-summary-client-control">
                  <select id="team-detail-member-filter" class="tk-select">
                    <option value="">Entire team</option>
                    ${detail.members.map((member) => `<option value="${member.id}">${this.escapeHtml(member.name)}</option>`).join('')}
                  </select>
                  <button id="team-detail-member-clear" type="button" class="tk-summary-client-clear" hidden>Clear</button>
                </div>
              </div>
            </div>
          </section>
          <div id="team-budget-detail-content"></div>`
        const filter = document.getElementById('team-detail-member-filter')
        this.detailMemberPicker = createChoices(filter, {
            searchPlaceholderValue: 'Start typing employee name...',
            searchResultLimit: 10,
            shouldSort: false,
            itemSelectText: '',
            placeholder: true,
            placeholderValue: 'Entire team',
        })
        this.initializeDetailStickyFilter()
        this.renderDetailContent(detail)
    }

    initializeDetailStickyFilter() {
        const filter = document.getElementById('team-detail-filter')
        const sentinel = document.getElementById('team-detail-filter-sentinel')
        if (!filter || !sentinel || !('IntersectionObserver' in window)) return
        const modal = filter.closest('.tk-modal')
        this.detailFilterObserver = new IntersectionObserver(([entry]) => {
            const docked = !entry.isIntersecting
            filter.classList.toggle('is-stuck', docked)
            modal?.classList.toggle('has-team-detail-filter-docked', docked)
        }, { root: this.detailBody, threshold: 0 })
        this.detailFilterObserver.observe(sentinel)
    }

    destroyDetailFilter() {
        this.detailFilterObserver?.disconnect()
        this.detailFilterObserver = null
        this.detailModal?.querySelector('.tk-modal')?.classList.remove('has-team-detail-filter-docked')
        this.detailMemberPicker?.destroy()
        this.detailMemberPicker = null
    }

    applyDetailMemberFilter() {
        if (!this.detail) return
        const filter = document.getElementById('team-detail-member-filter')
        const memberId = filter?.value || ''
        const clear = document.getElementById('team-detail-member-clear')
        if (clear) clear.hidden = !memberId
        if (memberId === this.detailMemberId) return
        this.detailMemberId = memberId
        this.renderDetailContent(this.detail)
        this.loadEntries(1)
    }

    renderDetailContent(detail) {
        const content = document.getElementById('team-budget-detail-content')
        if (!content) return
        const member = teamBudgetDetailScope(detail, this.detailMemberId)
        const scope = member || detail
        const usedWidth = Math.min(100, Math.max(0, scope.percent_used || 0))
        const importLine = detail.imported_at
            ? `${detail.import_row_count} rows · imported ${new Date(detail.imported_at).toLocaleString()}${detail.import_skipped_count ? ` · ${detail.import_skipped_count} skipped` : ''}`
            : 'No workbook imported yet.'
        const used = member
            ? this.memberTime(member.display_used_hours, member.used_seconds)
            : withHours(hours(detail.used_hours))
        const budgeted = member
            ? this.memberTime(member.budgeted_hours, member.budget_seconds)
            : `${hours(detail.budgeted_hours)} team hours`
        const remaining = member
            ? this.memberTime(member.display_remaining_hours, member.remaining_seconds)
            : `${hours(detail.remaining_hours)} hrs.`
        const members = member ? [member] : detail.members
        const weeks = member
            ? detail.member_weekly?.[String(member.id)] || []
            : detail.weekly
        content.innerHTML = `
          <section class="tk-status-scope" data-status="${scope.status}">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div><div class="text-3xl font-semibold text-text">${used}</div><div class="mt-1 text-xs text-muted">of ${budgeted} budgeted${member ? ` for ${this.escapeHtml(member.name)}` : ''}</div></div>
              <span class="tk-badge" style="color:var(--status-text);background:var(--status-soft)">${TEAM_STATUS_LABEL[scope.status]}</span>
            </div>
            <div class="mt-4 tk-meter tk-meter-lg"><div class="tk-meter-fill" style="width:${usedWidth}%"></div></div>
            <div class="mt-2 flex justify-between text-xs text-muted"><span>${remaining} remaining</span><span>${percent(scope.percent_used)}</span></div>
          </section>
          <div class="mt-5 grid gap-px overflow-hidden rounded-xl bg-border sm:grid-cols-3">
            <div class="bg-surface-2 p-3"><div class="tk-stat-label">Historical projection</div><div class="mt-1 text-lg font-semibold text-text">${hours(scope.projected_hours)} hrs.</div><div class="mt-1 text-xs text-faint">${scope.projection_as_of ? `through ${shortDate(scope.projection_as_of)}` : 'awaiting imported time'}</div></div>
            <div class="bg-surface-2 p-3"><div class="tk-stat-label">Members</div><div class="mt-1 text-lg font-semibold text-text">${members.length}</div></div>
            <div class="bg-surface-2 p-3"><div class="tk-stat-label">Imported rows</div><div class="mt-1 text-lg font-semibold text-text">${member ? member.entry_count : detail.entry_count}</div></div>
          </div>
          <div class="mt-5"><div class="tk-stat-label mb-2">Latest import</div><p class="text-sm text-muted">${importLine}</p></div>
          ${detail.notes ? `<div class="mt-5"><div class="tk-stat-label mb-2">Notes</div><p class="whitespace-pre-wrap text-sm text-muted">${this.escapeHtml(detail.notes)}</p></div>` : ''}
          <div class="mt-6">
            <h3 class="tk-card-title mb-3">Daily burn</h3>
            <div class="h-64"><canvas id="team-budget-burn-chart"></canvas></div>
          </div>
          <div class="mt-6"><h3 class="tk-card-title mb-3">Team members</h3>${this.memberTable(members)}</div>
          <div class="mt-6"><h3 class="tk-card-title mb-3">Time by week</h3>${this.weekTable(weeks)}</div>
          <div class="mt-6 border-t border-border pt-5">
            <h3 class="tk-card-title">Imported entries</h3>
            <div id="team-entry-results" class="mt-3"><div class="tk-empty py-6">Loading entries…</div></div>
          </div>`
        this.drawChart(detail)
    }

    memberTable(members) {
        return `<div class="overflow-x-auto rounded-lg border border-border"><table class="tk-table"><thead><tr><th>Member</th><th>Imported ID</th><th class="text-right">Budget</th><th class="text-right">Used</th><th class="text-right">Remaining</th></tr></thead><tbody>${members.map((member) => `<tr><td>${this.escapeHtml(member.name)}</td><td class="text-muted">${this.escapeHtml(member.source_user_id)}${member.aliases.length ? `<div class="text-xs text-faint">Also: ${member.aliases.map((value) => this.escapeHtml(value)).join(', ')}</div>` : ''}</td><td class="tabular text-right">${this.memberTime(member.budgeted_hours, member.budget_seconds)}</td><td class="tabular text-right">${this.memberTime(member.display_used_hours, member.used_seconds)}</td><td class="tabular text-right">${this.memberTime(member.display_remaining_hours, member.remaining_seconds)}</td></tr>`).join('')}</tbody></table></div>`
    }

    memberTime(decimalHours, exactSeconds) {
        if (this.roundingEnabled) {
            return `${this.formatDecimalHours(decimalHours)}<span class="font-normal text-faint"> hrs.</span>`
        }
        const sign = Number(exactSeconds) < 0 ? '−' : ''
        return `${sign}${exactDurationSeconds(Math.abs(Number(exactSeconds) || 0))}`
    }

    weekTable(weeks) {
        if (!weeks.length) return '<div class="tk-empty py-6">No imported weeks yet.</div>'
        return `<div class="overflow-x-auto rounded-lg border border-border"><table class="tk-table"><thead><tr><th>Week starting</th><th class="text-right">Imported hours</th></tr></thead><tbody>${weeks.map((week) => `<tr><td>${shortDate(week.week_start)}</td><td class="tabular text-right">${hours(week.hours)}</td></tr>`).join('')}</tbody></table></div>`
    }

    async loadEntries(page = 1) {
        const results = document.getElementById('team-entry-results')
        if (!results || !this.detailId) return
        const params = new URLSearchParams({ page, per_page: 50 })
        const memberId = this.detailMemberId
        if (memberId) params.set('member_id', memberId)
        results.innerHTML = '<div class="tk-empty py-6">Loading entries…</div>'
        try {
            const payload = await this.fetchFromAPI(`/api/team-budgets/${this.detailId}/entries?${params}`)
            if (!payload.entries.length) {
                results.innerHTML = '<div class="tk-empty py-6">No imported entries for this view.</div>'
                return
            }
            results.innerHTML = `<div class="overflow-x-auto rounded-lg border border-border"><table class="tk-table"><thead><tr><th>Date</th><th>Member</th><th>Imported ID</th><th class="text-right">Time</th></tr></thead><tbody>${payload.entries.map((entry) => `<tr><td>${shortDate(entry.date)}</td><td>${this.escapeHtml(entry.member_name)}</td><td class="text-muted">${this.escapeHtml(entry.source_user_id)}</td><td class="tabular text-right">${hours(entry.hours)} hrs.</td></tr>`).join('')}</tbody></table></div><div class="mt-3 flex items-center justify-between text-xs text-muted"><span>${payload.total} row${payload.total === 1 ? '' : 's'}</span><div class="flex gap-2"><button type="button" class="tk-btn tk-btn-secondary tk-btn-sm" data-team-entry-page="${payload.page - 1}" ${payload.page <= 1 ? 'disabled' : ''}>Previous</button><button type="button" class="tk-btn tk-btn-secondary tk-btn-sm" data-team-entry-page="${payload.page + 1}" ${payload.page >= payload.pages ? 'disabled' : ''}>Next</button></div></div>`
        } catch (error) {
            results.innerHTML = '<div class="tk-empty py-6">Could not load entries.</div>'
        }
    }

    drawChart(detail) {
        if (this.chart) this.chart.destroy()
        const canvas = document.getElementById('team-budget-burn-chart')
        if (!canvas) return
        const memberId = this.detailMemberId
        const member = teamBudgetDetailScope(detail, memberId)
        const burn = member ? detail.member_burn?.[memberId] || [] : detail.burn
        const css = getComputedStyle(document.documentElement)
        const token = (name) => css.getPropertyValue(name).trim()
        this.chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: burn.map((point) => shortDate(point.date)),
                datasets: [
                    { label: member ? `${member.name} imported` : 'Team imported', data: burn.map((point) => point.actual), borderColor: token('--accent'), backgroundColor: token('--accent-soft'), fill: true, pointRadius: 0, spanGaps: false, tension: 0.15 },
                    { label: member ? `${member.name} budget pace` : 'Team budget pace', data: burn.map((point) => point.ideal), borderColor: token('--faint'), borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { labels: { color: token('--muted') } } },
                scales: {
                    x: { ticks: { color: token('--faint'), maxTicksLimit: 8 }, grid: { color: token('--border') } },
                    y: { beginAtZero: true, ticks: { color: token('--faint') }, grid: { color: token('--border') } },
                },
            },
        })
    }

    bindImport() {
        this.importFileButton.addEventListener('click', () => this.importFile.click())
        this.previewButton.addEventListener('click', () => this.previewImport())
        this.importForm.addEventListener('submit', (event) => {
            event.preventDefault()
            this.confirmImport().catch(console.error)
        })
        this.importSheet.addEventListener('change', () => {
            this.columnMapping = null
            this.importColumns.classList.add('hidden')
            this.previewImport().catch(console.error)
        })
        this.importFile.addEventListener('change', () => {
            this.resetImportPreview(true)
        })
        this.importTimeFormat.addEventListener('change', () => this.resetImportPreview(false))
        this.importUserRows.addEventListener('change', (event) => {
            if (event.target.matches('[data-import-user-action]')) this.toggleNewMemberFields(event.target.closest('[data-import-user-row]'))
            this.updateImportConfirmState()
        })
        this.importUserRows.addEventListener('input', () => this.updateImportConfirmState())
    }

    openImport(detail) {
        this.importMode = 'existing'
        this.returnToTeamForm = false
        this.importReturnDetailId = detail.id
        this.importBudgetId = detail.id
        this.importDetail = detail
        this.hideModal(this.detailModal)
        this.resetImportDialog()
        this.importTitle.textContent = 'Import team time'
        this.importSubtitle.textContent = 'A confirmed import completely replaces the previous imported rows.'
        this.confirmImportButton.textContent = 'Replace imported data'
        this.showModal(this.importModal)
    }

    openStartingImport() {
        this.importMode = 'starting'
        this.returnToTeamForm = true
        this.importReturnDetailId = null
        this.importBudgetId = null
        this.importDetail = { members: [] }
        this.formModal.classList.add('hidden')
        this.resetImportDialog()
        this.importTitle.textContent = 'Start team budget from XLSX'
        this.importSubtitle.textContent = 'Preview the workbook, identify its members, and enter each person’s budgeted hours.'
        this.confirmImportButton.textContent = 'Use as starting point'
        this.importModal.classList.remove('hidden')
        this.importFileButton.focus()
    }

    resetImportDialog() {
        this.importForm.reset()
        this.importTimeFormat.value = 'decimal_hours'
        this.importColumns.classList.add('hidden')
        this.importPreviewPanel.classList.add('hidden')
        this.confirmImportButton.classList.add('hidden')
        this.previewButton.classList.remove('hidden')
        this.preview = null
        this.columnMapping = null
    }

    resetImportPreview(resetColumns) {
        this.preview = null
        this.importPreviewPanel.classList.add('hidden')
        this.confirmImportButton.classList.add('hidden')
        this.previewButton.classList.remove('hidden')
        if (resetColumns) {
            this.columnMapping = null
            this.importColumns.classList.add('hidden')
        }
    }

    importFormData(includeChoices = false) {
        const formData = new FormData()
        formData.append('file', this.importFile.files[0])
        formData.append('time_format', this.importTimeFormat.value)
        if (this.importSheet.value) formData.append('sheet', this.importSheet.value)
        if (this.columnMapping) formData.append('column_mapping', JSON.stringify(this.columnMapping))
        if (includeChoices) {
            formData.append('user_mapping', JSON.stringify(this.collectImportMappings()))
            formData.append('out_of_range_action', this.rangeAction())
        }
        return formData
    }

    async previewImport() {
        if (!this.importFile.files[0]) {
            this.showToast('Choose an .xlsx workbook first.', 'error')
            return
        }
        if (!this.importColumns.classList.contains('hidden')) {
            this.columnMapping = {
                date: this.importDateColumn.value,
                user: this.importUserColumn.value,
                time: this.importTimeColumn.value,
            }
        }
        this.previewButton.disabled = true
        try {
            const preview = await this.fetchFromAPI(
                this.importMode === 'starting'
                    ? '/api/team-budgets/imports/preview'
                    : `/api/team-budgets/${this.importBudgetId}/imports/preview`,
                { method: 'POST', body: this.importFormData() },
                { quiet: true, timeout: 30000 },
            )
            if (preview.mapping_required) {
                this.renderColumnMapping(preview)
                this.showToast('Map the workbook columns, then preview again.', 'info')
                return
            }
            this.preview = preview
            this.columnMapping = preview.column_mapping
            this.renderPreview(preview)
        } catch (error) {
            this.showToast(error.message, 'error')
        } finally {
            this.previewButton.disabled = false
        }
    }

    renderColumnMapping(preview) {
        this.importColumns.classList.remove('hidden')
        this.fillSelect(this.importSheet, preview.sheets, preview.sheet)
        for (const select of [this.importDateColumn, this.importUserColumn, this.importTimeColumn]) {
            this.fillSelect(select, preview.headers)
        }
        this.importPreviewPanel.classList.add('hidden')
        this.confirmImportButton.classList.add('hidden')
    }

    fillSelect(select, values, selected = '') {
        select.replaceChildren()
        values.forEach((value) => {
            const option = document.createElement('option')
            option.value = value
            option.textContent = value || '(blank)'
            option.selected = value === selected
            select.appendChild(option)
        })
    }

    renderPreview(preview) {
        this.importPreviewPanel.classList.remove('hidden')
        this.importSummary.innerHTML = `<strong>${preview.row_count}</strong> importable row${preview.row_count === 1 ? '' : 's'}${preview.date_min ? ` · ${shortDate(preview.date_min)} – ${shortDate(preview.date_max)}` : ''}${preview.future_row_count ? ` · <strong>${preview.future_row_count}</strong> future row${preview.future_row_count === 1 ? '' : 's'} skipped` : ''}${preview.replaces_rows ? ` · replaces ${preview.replaces_rows} existing row${preview.replaces_rows === 1 ? '' : 's'}` : ''}`
        this.importErrors.classList.toggle('hidden', !preview.validation_error_count)
        this.importErrors.textContent = preview.validation_error_count
            ? `${preview.validation_error_count} invalid row(s). ${preview.validation_errors.slice(0, 5).map((item) => `Row ${item.row}: ${item.error}`).join(' · ')}`
            : ''

        this.importUsers.classList.toggle('hidden', !preview.unknown_user_ids.length)
        this.importUsersHelp.textContent = this.importMode === 'starting'
            ? 'Each ID becomes a team member. Add an optional name and their individual budgeted hours.'
            : 'Mappings are saved for future reimports.'
        this.importUserRows.innerHTML = preview.unknown_user_ids.map((sourceId) => this.importUserRow(sourceId)).join('')
        this.importRangeChoice.classList.toggle('hidden', !preview.out_of_range_row_count)
        this.importOutsideDates.textContent = preview.out_of_range_row_count
            ? `${preview.out_of_range_row_count} row(s): ${preview.out_of_range_dates.map((item) => `${shortDate(item.date)} (${item.row_count})`).join(', ')}`
            : ''
        this.previewButton.classList.add('hidden')
        this.confirmImportButton.classList.remove('hidden')
        this.updateImportConfirmState()
    }

    importUserRow(sourceId) {
        const starting = this.importMode === 'starting'
        const members = this.importDetail?.members || []
        const inactive = starting ? '' : ' is-inactive'
        const disabled = starting ? '' : ' disabled'
        return `
          <tr data-import-user-row data-source-id="${encodeURIComponent(sourceId)}">
            <td><span class="tk-team-import-source-id">${this.escapeHtml(sourceId)}</span></td>
            <td>
              <select class="tk-select" data-import-user-action aria-label="Map imported user ${this.escapeHtml(sourceId)} as">
                <option value=""${starting ? '' : ' selected'}>Choose…</option>
                <option value="new"${starting ? ' selected' : ''}>New team member</option>
                ${members.map((member) => `<option value="existing:${member.id}">${this.escapeHtml(member.name)}</option>`).join('')}
              </select>
            </td>
            <td class="tk-team-import-member-cell${inactive}" data-new-member-cell>
              <input class="tk-input" data-import-display-name data-new-member-input maxlength="120" aria-label="Display name for ${this.escapeHtml(sourceId)}"${disabled} />
            </td>
            <td class="tk-team-import-member-cell${inactive}" data-new-member-cell>
              <input type="number" class="tk-input tabular" data-import-budget-hours data-new-member-input min="0.01" step="0.01" aria-label="Budgeted hours for ${this.escapeHtml(sourceId)}"${disabled} />
            </td>
          </tr>`
    }

    toggleNewMemberFields(row) {
        const active = row.querySelector('[data-import-user-action]').value === 'new'
        row.querySelectorAll('[data-new-member-cell]').forEach((cell) => {
            cell.classList.toggle('is-inactive', !active)
        })
        row.querySelectorAll('[data-new-member-input]').forEach((input) => {
            input.disabled = !active
        })
    }

    collectImportMappings() {
        const mappings = {}
        this.importUserRows.querySelectorAll('[data-import-user-row]').forEach((row) => {
            const sourceId = decodeURIComponent(row.dataset.sourceId)
            const value = row.querySelector('[data-import-user-action]').value
            if (value === 'new') {
                mappings[sourceId] = {
                    action: 'new',
                    display_name: row.querySelector('[data-import-display-name]').value.trim(),
                    budgeted_hours: Number(row.querySelector('[data-import-budget-hours]').value),
                }
            } else if (value.startsWith('existing:')) {
                mappings[sourceId] = { action: 'existing', member_id: Number(value.split(':')[1]) }
            }
        })
        return mappings
    }

    rangeAction() {
        return document.querySelector('[name="team-import-range-action"]:checked')?.value || 'skip'
    }

    updateImportConfirmState() {
        const errors = importChoiceErrors(this.preview, this.collectImportMappings(), this.rangeAction())
        this.confirmImportButton.disabled = errors.length > 0
        this.confirmImportButton.title = errors[0] || ''
    }

    async confirmImport() {
        const errors = importChoiceErrors(this.preview, this.collectImportMappings(), this.rangeAction())
        if (errors.length) {
            this.showToast(errors[0], 'error')
            return
        }
        this.confirmImportButton.disabled = true
        if (this.importMode === 'starting') {
            this.applyStartingImport()
            this.confirmImportButton.disabled = false
            return
        }
        try {
            const result = await this.fetchFromAPI(
                `/api/team-budgets/${this.importBudgetId}/imports`,
                { method: 'POST', body: this.importFormData(true) },
                { quiet: true, timeout: 60000 },
            )
            const id = this.importBudgetId
            this.importReturnDetailId = null
            this.hideModal(this.importModal)
            this.showToast(`Imported ${result.imported_rows} row${result.imported_rows === 1 ? '' : 's'}${result.skipped_rows ? `; skipped ${result.skipped_rows}` : ''}.`, 'success')
            await this.load()
            await this.openDetail(id)
        } catch (error) {
            this.showToast(error.message, 'error')
        } finally {
            this.confirmImportButton.disabled = false
        }
    }

    applyStartingImport() {
        const mappings = this.collectImportMappings()
        this.startingImport = {
            file: this.importFile.files[0],
            timeFormat: this.importTimeFormat.value,
            sheet: this.importSheet.value || '',
            columnMapping: this.columnMapping ? { ...this.columnMapping } : null,
            preview: { ...this.preview },
        }
        this.memberRows.innerHTML = ''
        this.preview.source_user_ids.forEach((sourceId) => {
            const mapping = mappings[sourceId]
            this.addMemberRow({
                source_user_id: sourceId,
                display_name: mapping.display_name,
                budgeted_hours: mapping.budgeted_hours,
            })
        })
        this.range.start = this.preview.date_min
        this.range.end = this.preview.date_max
        this.rangePicker.setDate([this.range.start, this.range.end], false)
        this.renderStartingImportSummary()
        this.hideModal(this.importModal)
        this.showToast('Workbook added. Review the team budget, then create it.', 'success')
    }

    renderStartingImportSummary() {
        const selected = this.startingImport
        this.startFileSummary.classList.toggle('hidden', !selected)
        this.startXlsxButton.textContent = selected ? 'Replace XLSX' : 'Choose XLSX'
        this.startFileSummary.textContent = selected
            ? `${selected.preview.row_count} row${selected.preview.row_count === 1 ? '' : 's'} · ${selected.preview.source_user_ids.length} team member${selected.preview.source_user_ids.length === 1 ? '' : 's'} · ${shortDate(selected.preview.date_min)} – ${shortDate(selected.preview.date_max)}`
            : ''
    }

    bindModals() {
        ;[this.formModal, this.detailModal, this.importModal].forEach(makeModalBackdropStatic)
        document.querySelectorAll('[data-close-team-modal]').forEach((button) => {
            button.addEventListener('click', () => this.hideModal(button.closest('.tk-modal-backdrop')))
        })
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return
            const open = [this.importModal, this.formModal, this.detailModal].find((modal) => !modal.classList.contains('hidden'))
            if (open) this.hideModal(open)
        })
    }

    showModal(modal) {
        if (!modal.classList.contains('hidden')) return
        modal.classList.remove('hidden')
        lockBodyScroll()
    }

    hideModal(modal) {
        if (!modal || modal.classList.contains('hidden')) return
        const returnToForm = modal === this.importModal && this.returnToTeamForm
        const returnToDetailId = modal === this.importModal
            ? this.importReturnDetailId
            : null
        modal.classList.add('hidden')
        unlockBodyScroll()
        if (modal === this.formModal) {
            this.startingImport = null
            this.editing = null
            disarmConfirm(this.deleteButton)
        }
        if (modal === this.detailModal) {
            this.destroyDetailFilter()
            this.detailId = null
            this.detail = null
            this.detailMemberId = ''
            if (this.chart) this.chart.destroy()
            this.chart = null
        }
        if (modal === this.importModal) {
            this.preview = null
            this.importBudgetId = null
            this.importDetail = null
            this.importMode = 'existing'
            this.returnToTeamForm = false
            this.importReturnDetailId = null
            if (returnToForm) this.showModal(this.formModal)
            else if (returnToDetailId) this.openDetail(returnToDetailId).catch(console.error)
        }
    }

    bindTheme() {
        document.addEventListener('themeChanged', () => {
            if (this.detail && !this.detailModal.classList.contains('hidden')) this.drawChart(this.detail)
        })
    }

    toISO(value) {
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    }
}


ready(() => {
    const page = new TeamBudgets()
    page.init().catch((error) => {
        console.error('Team budgets init failed, retrying:', error)
        setTimeout(() => page.init().catch(console.error), 3000)
    })
})
