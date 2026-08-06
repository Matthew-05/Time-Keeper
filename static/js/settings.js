import { TimeKeeper, ready } from './base.js'
import { applyTheme, currentMode } from './theme.js'

/**
 * Settings page.
 *
 * Each control applies its change immediately and saves in the background —
 * there's no Save button to forget to press, and with a local backend the write
 * is effectively instant. The optimistic apply is rolled back if the write
 * fails, so what you see always matches what's on disk.
 */
class Settings extends TimeKeeper {
    constructor() {
        super()
        this.themeGroup = document.getElementById('theme-mode')
    }

    init() {
        // The server already rendered the stored mode onto <html>; read it from
        // there rather than fetching it back.
        this.markSelected(currentMode())

        this.themeGroup.addEventListener('click', (event) => {
            const button = event.target.closest('[data-theme-option]')
            if (!button) return
            this.setTheme(button.dataset.themeOption)
        })

        // Arrow keys across a radiogroup, as expected for this role.
        this.themeGroup.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
            const options = [...this.themeGroup.querySelectorAll('[data-theme-option]')]
            const index = options.findIndex((b) => b.dataset.themeOption === currentMode())
            const step = event.key === 'ArrowRight' ? 1 : -1
            const next = options[(index + step + options.length) % options.length]
            event.preventDefault()
            next.focus()
            this.setTheme(next.dataset.themeOption)
        })
    }

    /** Reflect `mode` in the segmented control. */
    markSelected(mode) {
        this.themeGroup.querySelectorAll('[data-theme-option]').forEach((button) => {
            const selected = button.dataset.themeOption === mode
            button.classList.toggle('active', selected)
            button.setAttribute('aria-checked', selected ? 'true' : 'false')
            // Only the selected option stays in the tab order, per radiogroup
            // convention — arrow keys move between them.
            button.tabIndex = selected ? 0 : -1
        })
    }

    async setTheme(mode) {
        const previous = currentMode()
        if (mode === previous) return

        // Apply first: the point of a theme switch is seeing it happen.
        applyTheme(mode)
        this.markSelected(mode)

        try {
            const saved = await this.save({ theme: mode })
            // Trust the server's answer over ours — it validated the value.
            if (saved.theme !== mode) {
                applyTheme(saved.theme)
                this.markSelected(saved.theme)
            }
        } catch (error) {
            // The write failed, so the file still says `previous`. Put the page
            // back in sync with it instead of leaving a theme that won't
            // survive a reload.
            applyTheme(previous)
            this.markSelected(previous)
        }
    }

    /** PUT a partial settings object. Not retried — see fetchFromAPI. */
    save(changes) {
        return this.fetchFromAPI('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(changes),
        })
    }
}

ready(() => new Settings().init())
