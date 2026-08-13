const titlebar = document.getElementById('window-titlebar')
const controls = document.querySelectorAll('[data-window-action]')
const maximizeButton = document.querySelector('[data-window-action="maximize"]')
const resizeHandles = document.querySelectorAll('[data-resize-direction]')

const MIN_WINDOW_WIDTH = 800
const MIN_WINDOW_HEIGHT = 650

let pendingResize = null
let resizeRequestInFlight = false

function setMaximized(maximized) {
  titlebar?.classList.toggle('is-maximized', maximized)
  document.documentElement.classList.toggle('tk-window-maximized', maximized)
  if (!maximizeButton) return

  const label = maximized ? 'Restore' : 'Maximize'
  maximizeButton.setAttribute('aria-label', label)
  maximizeButton.title = label
}

async function flushResize() {
  if (resizeRequestInFlight || !pendingResize) return

  const update = pendingResize
  pendingResize = null
  resizeRequestInFlight = true

  try {
    await window.pywebview?.api.resize_window(
      update.width,
      update.height,
      update.direction,
    )
  } catch (error) {
    console.error('Could not resize the window:', error)
  } finally {
    resizeRequestInFlight = false
    if (pendingResize) requestAnimationFrame(flushResize)
  }
}

function queueResize(update) {
  pendingResize = update
  requestAnimationFrame(flushResize)
}

function beginResize(event) {
  if (event.button !== 0 || !window.pywebview?.api) return

  event.preventDefault()
  const handle = event.currentTarget
  const direction = handle.dataset.resizeDirection
  const startX = event.screenX
  const startY = event.screenY
  const startWidth = window.outerWidth || window.innerWidth
  const startHeight = window.outerHeight || window.innerHeight

  document.documentElement.classList.add('tk-window-resizing')
  document.documentElement.style.cursor = getComputedStyle(handle).cursor
  handle.setPointerCapture(event.pointerId)

  function resize(moveEvent) {
    const deltaX = moveEvent.screenX - startX
    const deltaY = moveEvent.screenY - startY
    const widthDelta = direction.includes('e')
      ? deltaX
      : direction.includes('w')
        ? -deltaX
        : 0
    const heightDelta = direction.includes('s')
      ? deltaY
      : direction.includes('n')
        ? -deltaY
        : 0

    queueResize({
      width: Math.max(MIN_WINDOW_WIDTH, startWidth + widthDelta),
      height: Math.max(MIN_WINDOW_HEIGHT, startHeight + heightDelta),
      direction,
    })
  }

  function finishResize() {
    handle.removeEventListener('pointermove', resize)
    handle.removeEventListener('pointerup', finishResize)
    handle.removeEventListener('pointercancel', finishResize)
    document.documentElement.classList.remove('tk-window-resizing')
    document.documentElement.style.cursor = ''
  }

  handle.addEventListener('pointermove', resize)
  handle.addEventListener('pointerup', finishResize)
  handle.addEventListener('pointercancel', finishResize)
}

function enableControls() {
  controls.forEach((control) => {
    control.disabled = false
  })
  document.documentElement.classList.add('pywebview-ready')
}

async function runWindowAction(action) {
  const api = window.pywebview?.api
  if (!api) return

  try {
    if (action === 'minimize') {
      await api.minimize()
    } else if (action === 'maximize') {
      setMaximized(await api.toggle_maximize())
    } else if (action === 'close') {
      await api.close()
    }
  } catch (error) {
    console.error(`Could not ${action} the window:`, error)
  }
}

controls.forEach((control) => {
  control.addEventListener('click', () => runWindowAction(control.dataset.windowAction))
})

resizeHandles.forEach((handle) => {
  handle.addEventListener('pointerdown', beginResize)
})

window.timeKeeperWindowChrome = Object.freeze({ setMaximized })

if (window.pywebview?.api) {
  enableControls()
} else {
  window.addEventListener('pywebviewready', enableControls, { once: true })
}
