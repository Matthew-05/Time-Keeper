/**
 * Theme application.
 *
 * The stored preference lives in settings.json and is rendered onto <html> as
 * `data-theme-mode` (light | dark | auto) plus the `.dark` class, both before
 * the page paints. Nothing here decides what the theme *is* — this module only
 * applies changes made during the life of the page:
 *
 *  - `auto` following the OS while the window is open, and
 *  - the settings page switching modes without a reload.
 *
 * Anything that bakes colours in at construction time (Chart.js, vis-timeline)
 * listens for the `themeChanged` event that both paths dispatch.
 */

const root = document.documentElement
const media = window.matchMedia('(prefers-color-scheme: dark)')

/** Is the OS asking for dark right now? */
function prefersDark() {
    return media.matches
}

/** The stored preference, as rendered by the server. */
export function currentMode() {
    return root.dataset.themeMode || 'auto'
}

/** Resolve a mode to an actual light/dark decision. */
function resolve(mode) {
    if (mode === 'dark') return true
    if (mode === 'light') return false
    return prefersDark()
}

/**
 * Apply `mode` to the document and announce it.
 *
 * Purely visual — persisting the choice is the caller's job (see settings.js),
 * so this stays usable for previewing a mode the user hasn't committed to.
 */
export function applyTheme(mode) {
    const dark = resolve(mode)
    root.dataset.themeMode = mode
    // toggle() with an explicit second argument, so re-applying the same theme
    // is a no-op rather than a flip.
    const changed = root.classList.contains('dark') !== dark
    root.classList.toggle('dark', dark)
    if (changed) {
        document.dispatchEvent(new CustomEvent('themeChanged', { detail: { dark, mode } }))
    }
    return dark
}

// Follow the OS, but only while the preference is actually `auto`. In light or
// dark the user has made an explicit choice and the OS doesn't get a vote.
media.addEventListener('change', () => {
    if (currentMode() !== 'auto') return
    applyTheme('auto')
})
