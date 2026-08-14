import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'http://localhost/',
})

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ frozen: false, state: 'idle' }),
})

const { StartupUpdatePrompt } = await import('../static/js/update_prompt.js')

const prompt = new StartupUpdatePrompt({ fetchFromAPI: async () => null })
const available = {
    frozen: true,
    state: 'available',
    current_version: '2.0.0',
    latest_version: '2.1.0',
    release_url: 'https://github.com/Matthew-05/Time-Keeper/releases/tag/v2.1.0',
    progress: null,
    error: null,
}

prompt.handleStatus(available)
assert.equal(document.querySelector('#startup-update-title').textContent.trim(), 'Update available')
assert.equal(document.querySelector('[data-update-versions]').textContent, 'v2.0.0 → v2.1.0')
assert.equal(document.querySelector('[data-update-action]').textContent, 'Download update')

prompt.handleStatus({ ...available, state: 'downloading', progress: 42 })
assert.equal(document.querySelector('[data-update-progress]').style.width, '42%')
assert.equal(document.querySelector('[data-update-progress-label]').textContent, '42%')
assert.equal(document.querySelector('[data-update-action]').disabled, true)

prompt.handleStatus({ ...available, state: 'ready', progress: 100 })
assert.equal(document.querySelector('#startup-update-title').textContent.trim(), 'Ready to install')
assert.equal(document.querySelector('[data-update-action]').textContent, 'Install and restart')
assert.equal(document.querySelector('[data-update-action]').disabled, false)

prompt.dismiss(false)
assert.equal(document.querySelector('.tk-update-backdrop'), null)

console.log('startup update prompt states render correctly')
