import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="field">
    <select id="client">
      <option value="">Choose a client…</option>
      <option value="1">Acme</option>
    </select>
  </div>
</body></html>`, { url: 'http://localhost/' })

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Element = dom.window.Element
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.HTMLInputElement = dom.window.HTMLInputElement
globalThis.HTMLSelectElement = dom.window.HTMLSelectElement
globalThis.CustomEvent = dom.window.CustomEvent
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.requestAnimationFrame = (callback) => callback()
globalThis.cancelAnimationFrame = () => {}
dom.window.matchMedia = () => ({ matches: false })
const { default: Choices } = await import('choices.js')
globalThis.Choices = Choices

const { createChoices } = await import('../static/js/base.js')
const select = document.getElementById('client')
const picker = createChoices(select, {
  searchEnabled: false,
  shouldSort: false,
})
const outer = picker.containerOuter.element

console.log('Choices client picker keyboard guard')

picker.setChoiceByValue('1')
picker.hideDropdown(true)
outer.focus()
outer.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'Control',
  keyCode: 17,
  ctrlKey: true,
  bubbles: true,
}))
assert.equal(picker.dropdown.isActive, false)
console.log('  ok   Control does not reopen a closed picker')

outer.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'c',
  keyCode: 67,
  ctrlKey: true,
  bubbles: true,
}))
assert.equal(picker.dropdown.isActive, false)
console.log('  ok   Control shortcuts do not reopen a closed picker')

outer.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'ArrowDown',
  keyCode: 40,
  bubbles: true,
}))
assert.equal(picker.dropdown.isActive, true)
console.log('  ok   ordinary keyboard navigation still opens the picker')

picker.destroy()
