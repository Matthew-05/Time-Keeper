import { clockTimeToSeconds } from './time_format.js';
import { renderInsight } from './insight.js';

/**
 * Run `fn` once the DOM is parsed.
 *
 * Every page used to call `document.addEventListener('DOMContentLoaded', …)`
 * from inside a module. Modules are deferred, so if evaluation lands after the
 * event has already fired the listener is registered too late and simply never
 * runs — the page renders its loading placeholders and sits there forever with
 * no error. Checking readyState first removes that race entirely.
 */
export function ready(fn) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
        // Already parsed — don't wait for an event that has been and gone.
        fn();
    }
}

/**
 * Keep the quiet required-field treatment in sync with workflow state.
 *
 * Native forms can use `data-required-auto` and CSS validity. Stateful screens
 * (Today, Add task, Manual adjustment) have prerequisites that HTML cannot
 * express, so they call this when their own validity calculation changes.
 */
export function setRequiredState(container, incomplete) {
    if (!container) return;
    container.classList.toggle('is-incomplete', Boolean(incomplete));
    container.classList.toggle('is-complete', !incomplete);
}

/**
 * Construct a Choices picker with the app's keyboard guard.
 *
 * Choices 11 opens a closed select on almost every keydown. After selecting an
 * item it deliberately returns focus to its outer container, so pressing Ctrl,
 * Alt, Meta, or a shortcut chord immediately reopens the dropdown. The vendor
 * handler is a prototype method, so a small subclass can decline those keys
 * before the vendor behavior runs. Ordinary text and navigation keys are left
 * untouched, and the event itself still propagates for app-level shortcuts.
 */
export function createChoices(element, config) {
    class TimeKeeperChoices extends Choices {
        _onKeyDown(event) {
            const isCommandKey = event.ctrlKey
                || event.metaKey
                || ['Control', 'Meta', 'Alt'].includes(event.key);
            if (!this.dropdown.isActive && isCommandKey) return;
            super._onKeyDown(event);
        }
    }

    return new TimeKeeperChoices(element, config);
}

/**
 * Page templates render their modal markup inside <main>, whose fixed-position
 * stacking context sits below the title bar and navigation. Mounting backdrops
 * directly under <body> lets their z-index cover the complete app chrome, just
 * like the dynamically-created unsaved-changes confirmation.
 */
function mountModalBackdrops() {
    document.querySelectorAll('main .tk-modal-backdrop').forEach((backdrop) => {
        document.body.appendChild(backdrop);
    });
}

ready(mountModalBackdrops);

/** Keep backdrop clicks inert; dialogs close only through explicit controls. */
export function makeModalBackdropStatic(backdrop) {
    backdrop.addEventListener('click', (event) => {
        if (event.target !== backdrop) return;
        event.preventDefault();
        event.stopPropagation();
    });
}

/**
 * One delegated popover for every insight control and budget meter in the app.
 * Delegation also covers elements rendered after page load.
 */
let insightPopover = null;

/**
 * Is a status breakdown currently on screen?
 *
 * Background refreshes consult this. The popover is a single shared element
 * positioned against whichever trigger opened it, so replacing that trigger's
 * markup underneath leaves the popover floating next to nothing — `mouseout`
 * can't fire on a node that no longer exists.
 */
export function isInsightOpen() {
    return Boolean(insightPopover) && !insightPopover.classList.contains('hidden');
}

/**
 * The popover element, made on first use.
 *
 * Lazily, because callers are no longer only the delegated listeners below:
 * `showInsight` is exported, and a page module can reach for it before `ready`
 * has run.
 */
function popoverElement() {
    if (!insightPopover) {
        insightPopover = document.createElement('div');
        insightPopover.className = 'tk-insight-popover hidden';
        insightPopover.setAttribute('role', 'tooltip');
        document.body.appendChild(insightPopover);
    }
    return insightPopover;
}

/**
 * Put an insight on screen, anchored to `target`.
 *
 * **This is the app's only tooltip.** Anything that wants one calls this rather
 * than styling a box of its own — which is what the timeline used to do, by way
 * of vis-timeline's built-in tooltip, and it cost a running argument with a
 * vendor stylesheet to keep it looking like the rest of the app. Owning the
 * element ends that argument: there is nothing to out-specify, because nothing
 * else has an opinion about it.
 *
 * `text` defaults to the trigger's own `data-insight`, which is how every
 * delegated caller uses it. Pass it explicitly when the trigger is an element
 * you don't control the attributes of.
 */
export function showInsight(target, text = target?.dataset?.insight) {
    if (!target || !text) return;
    const popover = popoverElement();

    // Measured *after* the content is in, because a structured insight is
    // several lines tall and the old single-line height would place it
    // overlapping the control it describes.
    renderInsight(popover, text);
    popover.classList.remove('hidden');

    const anchor = target.getBoundingClientRect();
    const tip = popover.getBoundingClientRect();
    let left = anchor.left + anchor.width / 2 - tip.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8));

    // Above by preference, below if it doesn't fit, and clamped either way.
    // A figure table is several times taller than the one-liners this used
    // to show, so "flip below" alone can now run off the bottom instead.
    let top = anchor.top - tip.height - 8;
    if (top < 8) top = anchor.bottom + 8;
    top = Math.max(8, Math.min(top, window.innerHeight - tip.height - 8));

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

/** Take it off screen. Safe to call when nothing is showing. */
export function hideInsight() {
    insightPopover?.classList.add('hidden');
}

function bindInsightPopovers() {
    const show = (target) => showInsight(target);
    const hide = hideInsight;

    document.addEventListener('mouseover', (event) => {
        const target = event.target.closest?.('.tk-insight, .tk-meter-tooltip');
        if (target) show(target);
    });
    document.addEventListener('mouseout', (event) => {
        const target = event.target.closest?.('.tk-insight, .tk-meter-tooltip');
        if (target && !target.contains(event.relatedTarget)) hide();
    });
    document.addEventListener('focusin', (event) => {
        const target = event.target.closest?.('.tk-insight, .tk-meter-tooltip');
        if (target) show(target);
    });
    document.addEventListener('focusout', (event) => {
        if (event.target.closest?.('.tk-insight, .tk-meter-tooltip')) hide();
    });
    document.addEventListener('click', (event) => {
        const target = event.target.closest?.('.tk-insight');
        if (!target) {
            hide();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        show(target);
    });
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
}

ready(bindInsightPopovers);

/**
 * Sliding highlight for `.tk-segmented` controls.
 *
 * Each caller (settings, budgets filter, work calendar overrides, the
 * summary tabs, …) just toggles `.active` on a `.tk-segment` the way it
 * always has — none of that click-handling code needs to know this exists.
 * This mounts one absolutely-positioned `.tk-segment-indicator` per
 * container, watches for the `.active` class moving via MutationObserver,
 * and re-measures the newly active button so the fill slides over to it
 * instead of the two buttons cross-fading their own backgrounds.
 */
function bindSegmentedIndicators() {
    document.querySelectorAll('.tk-segmented').forEach((container) => {
        const indicator = document.createElement('span');
        indicator.className = 'tk-segment-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        container.insertBefore(indicator, container.firstChild);

        const place = (skipTransition = false) => {
            const activeSegment = container.querySelector(':scope > .tk-segment.active');
            if (!activeSegment) {
                indicator.style.width = '0px';
                return;
            }

            // Resize/first paint shouldn't visibly slide in from the corner —
            // jump straight there, then hand control back to the stylesheet's
            // transition for every change after this one.
            if (skipTransition) indicator.style.transition = 'none';
            indicator.style.left = `${activeSegment.offsetLeft}px`;
            indicator.style.width = `${activeSegment.offsetWidth}px`;
            if (skipTransition) {
                indicator.offsetHeight; // eslint-disable-line no-unused-expressions -- force reflow
                indicator.style.transition = '';
            }
        };

        place(true);
        new MutationObserver(() => place()).observe(container, {
            attributes: true,
            attributeFilter: ['class'],
            subtree: true,
        });
        window.addEventListener('resize', () => place(true));
        // Some segmented controls live in a budget workspace panel that is
        // hidden during first paint. Their initial width is therefore zero;
        // remeasure after the workspace becomes visible so the blue indicator
        // lands under the already-active segment instead of disappearing.
        document.addEventListener('budgetViewChanged', () => place(true));
    });
}

ready(bindSegmentedIndicators);

/** Surface anything that escapes a promise chain instead of failing silently. */
window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
});

/**
 * Body-scroll lock for modals, reference-counted.
 *
 * The budgets page can stack two modals (detail, then an editor on top of
 * it), so a plain boolean would unlock the page as soon as the inner one
 * closed while the outer was still open. Counting opens/closes keeps the
 * lock held until every modal that asked for it has let go.
 */
let scrollLockCount = 0;

export function lockBodyScroll() {
    scrollLockCount++;
    document.documentElement.classList.add('tk-scroll-locked');
}

export function unlockBodyScroll() {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) {
        document.documentElement.classList.remove('tk-scroll-locked');
    }
}

/**
 * Click-twice-to-confirm for destructive buttons.
 *
 * The app deliberately never calls `confirm()`: a browser-native dialog in the
 * pywebview shell is a modal OS window that steals focus, ignores the theme,
 * and reads as a system error rather than part of the page. Instead the button
 * itself arms — its label becomes "Confirm?" and it goes solid danger — and the
 * second click within `timeout` performs the action.
 *
 * Every delete in the app went its own way here (client manager, works list,
 * budgets, task browser), so this is the one implementation they all share.
 * Anything that arms disarms again on a timeout, on a click elsewhere, or on
 * Escape, so nothing is left sitting in a confirm state waiting to be hit.
 */
const ARMED_CLASS = 'tk-btn-danger-armed';

/* The variant classes carry the button's resting colour, which the armed state
   replaces. Only these are removed and restored, so a button keeps its
   size/layout classes (tk-btn-sm, hidden, …) untouched. `text-danger` is in the
   list because a Tailwind utility outranks the component class and would
   otherwise paint red text onto the solid red armed background. */
const BUTTON_VARIANTS = [
    'tk-btn-danger',
    'tk-btn-warn',
    'tk-btn-secondary',
    'tk-btn-ghost',
    'text-danger',
];

const armedButtons = new Map();

export function isConfirmArmed(button) {
    return armedButtons.has(button);
}

/** Return an armed button to its resting state. Safe to call unconditionally. */
export function disarmConfirm(button) {
    const state = armedButtons.get(button);
    if (!state) return false;

    clearTimeout(state.timer);
    armedButtons.delete(button);
    // Restored as markup, not text: arming replaces the button's contents, and
    // some of these buttons hold an icon element alongside their label.
    button.innerHTML = state.content;
    button.classList.remove(ARMED_CLASS);
    state.variants.forEach((variant) => button.classList.add(variant));
    delete button.dataset.confirmMode;
    return true;
}

/**
 * Arm `button`, or run `onConfirm` if it is already armed.
 *
 * Call it from the button's own click handler and let it decide which of the
 * two clicks this is:
 *
 *     button.addEventListener('click', () => confirmAction(button, () => this.remove(id)))
 */
export function confirmAction(button, onConfirm, { label = 'Confirm?', timeout = 3000 } = {}) {
    if (!button) return onConfirm();

    if (armedButtons.has(button)) {
        disarmConfirm(button);
        return onConfirm();
    }

    const variants = BUTTON_VARIANTS.filter((variant) => button.classList.contains(variant));
    variants.forEach((variant) => button.classList.remove(variant));
    button.classList.add(ARMED_CLASS);

    armedButtons.set(button, {
        content: button.innerHTML,
        variants,
        // A button that was re-rendered away can't be restored, but it must
        // still leave the map or it would confirm on its first click if the
        // same element came back.
        timer: setTimeout(() => {
            if (button.isConnected) disarmConfirm(button);
            else armedButtons.delete(button);
        }, timeout),
    });

    button.textContent = label;
    button.dataset.confirmMode = 'true';
    return undefined;
}

/* Capture phase, so an armed button that isn't the one being clicked is reset
   before the click's own handler runs. `contains` keeps a click on an icon or
   label inside the armed button counting as the confirming click. */
document.addEventListener('click', (event) => {
    if (!armedButtons.size) return;
    [...armedButtons.keys()].forEach((button) => {
        if (button !== event.target && !button.contains(event.target)) disarmConfirm(button);
    });
}, true);

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !armedButtons.size) return;
    [...armedButtons.keys()].forEach((button) => disarmConfirm(button));
});

/**
 * Stable per-client colour, shared by the History timeline and Summary charts.
 * A stored value wins; the name-derived hue is the compatibility fallback for
 * removed clients and payloads produced by an older app process.
 *
 * The hue is derived from the client's name rather than from its position in a
 * list. Those two pages see different sets of clients — History sees one day,
 * Summary sees a whole range — so index-based assignment gave the same client a
 * different colour on each page. Hashing the name makes it agree everywhere and
 * survive a client being added or removed.
 *
 * Saturation and lightness are fixed rather than tokenised: these categorical
 * chips use clientForeground() to stay legible in both themes without
 * re-rendering on `themeChanged`.
 */
export function clientColor(name, storedColor = null) {
    if (typeof storedColor === 'string' && /^#[0-9a-f]{6}$/i.test(storedColor)) {
        return storedColor;
    }
    const key = String(name ?? '');
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
    }
    return `hsl(${Math.abs(hash) % 360}, 62%, 58%)`;
}

/**
 * Readable foreground paired with clientColor(), chosen from relative
 * luminance so both stored hex colours and generated HSL colours remain clear.
 */
export function clientForeground(name, storedColor = null) {
    const background = clientColor(name, storedColor);
    const hex = background.match(/^#([0-9a-f]{6})$/i);
    let channels;
    if (hex) {
        channels = [0, 2, 4].map((offset) => (
            parseInt(hex[1].slice(offset, offset + 2), 16) / 255
        ));
    } else {
        const match = background.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
        const hue = Number(match[1]) / 360;
        const saturation = Number(match[2]) / 100;
        const lightness = Number(match[3]) / 100;
        const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
        const section = hue * 6;
        const x = chroma * (1 - Math.abs(section % 2 - 1));
        channels = section < 1 ? [chroma, x, 0]
            : section < 2 ? [x, chroma, 0]
                : section < 3 ? [0, chroma, x]
                    : section < 4 ? [0, x, chroma]
                        : section < 5 ? [x, 0, chroma]
                            : [chroma, 0, x];
        const offset = lightness - chroma / 2;
        channels = channels.map((channel) => channel + offset);
    }
    const luminance = channels
        .map((channel) => channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);

    const darkContrast = (luminance + 0.05) / 0.05;
    const lightContrast = 1.05 / (luminance + 0.05);
    return darkContrast >= lightContrast ? '#000000' : '#ffffff';
}

/** Human-readable logged duration with both units and correct plurals. */
export function formatDurationMinutes(minutes) {
    const totalMinutes = Math.max(0, Math.round(Number(minutes) || 0));
    const hours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    return `${hours} ${hours === 1 ? 'hr' : 'hrs'} `
        + `${remainingMinutes} ${remainingMinutes === 1 ? 'min' : 'mins'}`;
}

/** Decimal-hour display for policy-rounded values, without trailing zeroes. */
export function formatDecimalHours(hours) {
    return Number(Number(hours).toFixed(2)).toString();
}

/* -------------------------------------------------------------------------
   Periodic refresh
   ------------------------------------------------------------------------- */

/** Every live poller on the page, so one teardown can stop all of them. */
const activePollers = new Set();

/**
 * Run an async task on a repeating schedule.
 *
 * This exists because `setInterval(() => somethingAsync(), 60000)` is wrong in
 * four ways that all showed up here:
 *
 *  - **It doesn't await.** The interval fires on a fixed wall-clock cadence
 *    regardless of whether the previous run finished. `fetchFromAPI` retries a
 *    failing read for up to a minute, so a server hiccup meant a second request
 *    launched on top of the first, then a third, each racing to write the same
 *    DOM. Self-scheduling from the *end* of the run makes overlap impossible.
 *  - **It drifts.** These refreshes exist to keep a minute-resolution figure
 *    honest, and a fixed 60s delay lands wherever the first tick happened to
 *    fall — up to 59s of staleness, permanently. Aligning to the next real
 *    minute boundary keeps the number correct the moment it changes.
 *  - **It runs while nobody is looking.** A minimised desktop app polled all
 *    day for a screen no one could see. Pausing while hidden and refreshing
 *    once on the way back is the same UX for none of the requests.
 *  - **It never stops.** Nothing cleared these, so navigating away left the
 *    fetch in flight against a torn-down page.
 *
 * `task` may be sync or async; its returned promise is awaited. Rejections are
 * logged, never thrown — a poller that dies on one bad response stops updating
 * the page for the rest of the session, which is the failure this is meant to
 * prevent. Because reads already retry internally, a rejection here means a
 * real outage, so the cadence backs off up to `maxBackoff` and resets on the
 * first success.
 *
 * `shouldSkip` is the second half of "don't interrupt the user". Patching the
 * DOM in place (see `reconcileChildren`) means a refresh no longer destroys
 * what someone is working on, but there are interactions no amount of careful
 * patching makes safe to refresh underneath — a modal reading a row that the
 * response is about to change, a half-typed time in an input. For those the
 * tick is *deferred*, not dropped: the schedule carries on, and `resume()`
 * runs the skipped work the moment the interaction ends, so the page is never
 * left showing stale data once it's free to update.
 *
 * @param {() => (void|Promise<void>)} task   Work to run each tick.
 * @param {object}  [options]
 * @param {number}  [options.interval=60000]  Base period, ms.
 * @param {boolean} [options.align=true]      Snap ticks to interval boundaries.
 * @param {boolean} [options.immediate=false] Run once now instead of waiting.
 * @param {boolean} [options.pauseWhenHidden=true] Idle while the page is hidden.
 * @param {() => boolean} [options.shouldSkip] Defer the tick while this is true.
 * @param {number}  [options.maxBackoff=300000] Ceiling for the failure backoff.
 * @param {string}  [options.name='poller']   Label used in console warnings.
 * @returns {{refresh: () => Promise<void>, resume: () => Promise<void>,
 *            stop: () => void, isRunning: () => boolean, isDeferred: () => boolean}}
 */
export function createPoller(task, {
    interval = 60000,
    align = true,
    immediate = false,
    pauseWhenHidden = true,
    shouldSkip = null,
    maxBackoff = 300000,
    name = 'poller',
} = {}) {
    let timer = null;
    let stopped = false;
    let running = false;
    let failures = 0;
    // Set while a run is in flight so a visibility change or a manual refresh
    // joins the existing run rather than starting a competing one.
    let inFlight = null;
    // A tick that `shouldSkip` turned away. Remembered so `resume()` knows
    // there is work owed rather than having to refresh unconditionally.
    let deferred = false;

    /**
     * Delay to the next tick.
     *
     * Aligned mode targets the next boundary of `interval` on the wall clock,
     * so a 60s poller fires at :00 of each minute no matter when it started or
     * how long the last run took. A run that overruns its own boundary simply
     * aims at the next one — never a zero-length wait that would spin.
     */
    function nextDelay() {
        if (failures > 0) {
            // Exponential, capped. Unaligned deliberately: during an outage the
            // point is to stop hammering, not to hit a boundary.
            return Math.min(maxBackoff, interval * 2 ** Math.min(failures, 8));
        }
        if (!align) return interval;
        const remainder = Date.now() % interval;
        return interval - remainder || interval;
    }

    function schedule() {
        if (stopped || timer !== null) return;
        // Nothing to schedule while hidden — `visibilitychange` restarts us.
        if (pauseWhenHidden && document.hidden) return;
        timer = setTimeout(() => {
            timer = null;
            run();
        }, nextDelay());
    }

    async function run({ force = false } = {}) {
        if (stopped) return;
        // Coalesce: concurrent callers await the run already happening.
        if (inFlight) return inFlight;

        // Busy. Note the debt and reschedule — `resume()` settles it. `force`
        // is how an explicit refresh() overrides the guard, since a caller
        // asking directly has already decided the moment is right.
        if (!force && shouldSkip?.()) {
            deferred = true;
            schedule();
            return;
        }
        deferred = false;

        running = true;
        inFlight = (async () => {
            try {
                await task();
                failures = 0;
            } catch (error) {
                failures++;
                console.warn(`[${name}] refresh failed (${failures}):`, error);
            } finally {
                running = false;
                inFlight = null;
            }
        })();

        await inFlight;
        schedule();
    }

    function onVisibilityChange() {
        if (!pauseWhenHidden) return;
        if (document.hidden) {
            // Drop the pending timer; the data will be refetched on return
            // anyway, so firing it in the background buys nothing.
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            return;
        }
        // Back on screen. Whatever is displayed was computed at least one
        // interval ago, so refresh now rather than waiting for a boundary.
        run();
    }

    const poller = {
        /**
         * Run the task now, resetting the schedule around it.
         *
         * Ignores `shouldSkip`: an explicit call is a caller stating the moment
         * is right, and honouring the guard here would make refresh() silently
         * do nothing exactly when a page most wants a repaint.
         */
        async refresh() {
            if (stopped) return;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            await run({ force: true });
        },
        /**
         * Settle a tick that `shouldSkip` turned away.
         *
         * Call when the blocking interaction ends — modal closed, edit saved or
         * cancelled. A no-op if nothing was actually skipped, so it's safe to
         * wire into every exit path without checking first.
         */
        async resume() {
            if (stopped || !deferred) return;
            if (shouldSkip?.()) return;   // something else still has the page
            await poller.refresh();
        },
        /** Cancel permanently. Safe to call more than once. */
        stop() {
            if (stopped) return;
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            document.removeEventListener('visibilitychange', onVisibilityChange);
            activePollers.delete(poller);
        },
        isRunning: () => running,
        isDeferred: () => deferred,
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    activePollers.add(poller);

    if (immediate) {
        run();
    } else {
        schedule();
    }

    return poller;
}

/** Stop every poller on the page. */
export function stopAllPollers() {
    for (const poller of [...activePollers]) poller.stop();
}

/**
 * Update a list of elements in place instead of rebuilding it.
 *
 * `container.innerHTML = items.map(render).join('')` is the pattern this
 * replaces, and it is fine exactly once — on first paint. On a *refresh* it
 * throws away live state that only exists in the DOM, which on this app meant:
 * a row the user was editing, complete with what they'd typed; every expanded
 * detail row (that fold state is a `hidden` class and nothing else); focus;
 * scroll position; and the flatpickr instance bound to each time input, which
 * was leaked rather than destroyed because nothing told it the input was gone.
 *
 * So instead: match each item to the element already representing it, update
 * only what changed, create only what's new, remove only what's gone. An
 * element that survives is the *same* element — so anything the browser or the
 * user put on it survives too, because it was never touched.
 *
 * `create` may return one element or several. Several is what a table needs
 * here, where one client is a summary `<tr>` and a detail `<tr>` side by side
 * as siblings; they're keyed identically and moved as a unit.
 *
 * @param {Element} container            Parent whose children are managed.
 * @param {Array} items                  Desired contents, in display order.
 * @param {object} handlers
 * @param {(item: any) => string|number} handlers.key    Stable identity per item.
 * @param {(item: any) => Element|Element[]} handlers.create  Build a missing entry.
 * @param {(els: Element[], item: any) => void} [handlers.update]  Patch a surviving entry.
 * @param {(els: Element[], item: any) => boolean} [handlers.skip] Leave an entry untouched.
 * @param {(els: Element[]) => void} [handlers.remove]    Tear down a departing entry.
 * @param {string} [handlers.keyAttr='data-rk']           Attribute holding the key.
 */
export function reconcileChildren(container, items, {
    key,
    create,
    update,
    skip,
    remove,
    keyAttr = 'data-rk',
} = {}) {
    if (!container) return;

    // Index what's already there. Anything unkeyed is scaffolding rather than
    // data — a loading spinner, an empty-state row — and has no counterpart in
    // `items`, so it goes.
    const existing = new Map();
    for (const child of Array.from(container.children)) {
        const childKey = child.getAttribute(keyAttr);
        if (childKey === null) {
            child.remove();
            continue;
        }
        if (!existing.has(childKey)) existing.set(childKey, []);
        existing.get(childKey).push(child);
    }

    const wanted = new Set(items.map((item) => String(key(item))));

    // Departures first, so the ordering pass below only ever walks elements
    // that are staying and can use plain sibling comparison.
    for (const [childKey, els] of existing) {
        if (wanted.has(childKey)) continue;
        remove?.(els);
        els.forEach((el) => el.remove());
        existing.delete(childKey);
    }

    // Walk the desired order with a cursor into the surviving children. An
    // element already in the right place is left completely alone — no move,
    // no reinsertion. That matters beyond performance: re-inserting a node
    // blurs it if it holds focus, which would defeat the point of all this.
    let cursor = container.firstElementChild;
    for (const item of items) {
        const itemKey = String(key(item));
        let els = existing.get(itemKey);

        if (els) {
            if (!skip?.(els, item)) update?.(els, item);
        } else {
            const created = create(item);
            els = Array.isArray(created) ? created : [created];
            els.forEach((el) => el.setAttribute(keyAttr, itemKey));
        }

        for (const el of els) {
            if (el === cursor) cursor = cursor.nextElementSibling;
            else container.insertBefore(el, cursor);
        }
    }
}

/**
 * Set text only when it differs.
 *
 * Assigning identical text still dirties the node, and a dirtied node inside a
 * selection collapses it — which is how a background refresh used to wipe out
 * a user mid-drag over a number they were copying.
 */
export function setText(el, value) {
    if (!el) return;
    const next = value == null ? '' : String(value);
    if (el.textContent !== next) el.textContent = next;
}

/** As `setText`, for the cases that genuinely need markup. */
export function setHtml(el, value) {
    if (!el) return;
    const next = value == null ? '' : String(value);
    if (el.innerHTML !== next) el.innerHTML = next;
}

/**
 * Teardown on navigation.
 *
 * `pagehide` rather than `unload`: it fires for the back/forward cache too, and
 * `unload` is the one browsers are actively removing. The app is a multi-page
 * Flask site inside pywebview, so every nav is a real document teardown and
 * without this the outgoing page's fetches carry on against dead DOM.
 */
window.addEventListener('pagehide', stopAllPollers);

export class TimeKeeper {
    constructor() {
        const root = document.documentElement.dataset;
        this.roundingEnabled = root.roundingEnabled === 'true';
        this.roundingIntervalMinutes = Number(root.roundingIntervalMinutes) || 15;
        this.roundingDirection = ['nearest', 'up', 'down'].includes(root.roundingDirection)
            ? root.roundingDirection
            : 'nearest';
        this.ensureToastContainer();

    }

    /**
     * The one place toasts are mounted, on every page.
     *
     * Appended to <body> rather than to whatever triggered the toast, and
     * stacked above everything via `.tk-toast-container` — see the z-index
     * scale in app.css. A toast is the app's only channel for "that failed",
     * and the actions most likely to fail are the ones inside a modal or
     * behind an open date picker. A toast that renders underneath the thing
     * that caused it is the same as no toast at all.
     */
    ensureToastContainer() {
        if (!document.getElementById('toast-container')) {
            const toastContainer = document.createElement('div');
            toastContainer.id = 'toast-container';
            toastContainer.className =
                'tk-toast-container fixed bottom-9 right-4 flex flex-col-reverse gap-2';
            document.body.appendChild(toastContainer);
        }
    }

    /**
     * Fetch JSON from the local Flask server.
     *
     * Two things this guards against, both of which used to hang a page:
     *
     *  - A request that never settles. `fetch` has no default timeout, so a
     *    connection the server never answers leaves the caller awaiting
     *    forever and the loading placeholder on screen permanently.
     *  - A transient failure. Pages fire several requests at once on load, and
     *    the server plus SQLite can briefly refuse or lock under that.
     *
     * The backend is local and ours, so reads simply hammer it until they
     * succeed — there's no shared service to be polite to, and a read that
     * eventually works is strictly better than an error the user has to act on.
     *
     * Writes are NOT retried by default. A POST that reached the server but
     * whose response was lost would be replayed, which for this app means a
     * duplicate task or client. Pass `retries` explicitly to override.
     */
    async fetchFromAPI(endpoint, options = {}, overrides = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const idempotent = method === 'GET' || method === 'HEAD';

        const {
            timeout = 10000,
            // ~40 attempts over roughly a minute: long enough to ride out a
            // slow start or a locked database, short enough to eventually stop.
            retries = idempotent ? 40 : 0,
            quiet = idempotent,
        } = overrides;

        let lastError;

        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);

            try {
                const response = await fetch(endpoint, { ...options, signal: controller.signal });
                if (!response.ok) {
                    // Prefer the server's own message. Routes reject with
                    // {'error': '...'} and that text is written for the user —
                    // "That work is already on the list" beats "409 CONFLICT".
                    let serverMessage = null;
                    try {
                        const body = await response.json();
                        if (body && typeof body.error === 'string') serverMessage = body.error;
                    } catch {
                        // Not JSON (a 500 HTML page, say) — fall back to the status.
                    }
                    const error = new Error(
                        serverMessage || `${response.status} ${response.statusText} — ${endpoint}`
                    );
                    error.status = response.status;
                    throw error;
                }
                return await response.json();
            } catch (error) {
                lastError = error.name === 'AbortError'
                    ? new Error(`Request timed out after ${timeout}ms — ${endpoint}`)
                    : error;

                // Don't retry a request the caller deliberately cancelled.
                if (options.signal?.aborted) throw lastError;

                // Nor a 4xx: the server understood and refused. Retrying a
                // bad parameter or a missing row 40 times just delays the
                // error by a minute and hammers the app while it waits.
                if (lastError.status >= 400 && lastError.status < 500) break;

                if (attempt < retries) {
                    // Fast at first so a blip is invisible, then back off to a
                    // steady 2s poll so a longer outage recovers on its own.
                    const delay = Math.min(2000, 150 * 2 ** Math.min(attempt, 4));
                    console.warn(`Retrying ${endpoint} in ${delay}ms after: ${lastError.message}`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            } finally {
                clearTimeout(timer);
            }
        }

        console.error('API Error:', lastError);
        if (quiet) throw lastError;
        this.showToast(lastError.message, 'error');
        throw lastError;
    }

    showToast(message, type = 'success') {
        // Ensure toast container exists
        this.ensureToastContainer();

        const toastContainer = document.getElementById('toast-container');

        // Colour names are legacy call sites; map them onto the semantic variants.
        const variants = {
            success: 'success',
            error: 'error',
            warning: 'warning',
            info: 'info',
            green: 'success',
            red: 'error',
            yellow: 'warning',
            blue: 'info'
        };
        const variant = variants[type] || 'info';

        const icons = {
            success: '<path d="M20 6L9 17l-5-5"/>',
            error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
            warning: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
            info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'
        };

        // Written out in full rather than interpolated so Tailwind's scanner
        // can actually see these class names.
        const iconColour = {
            success: 'text-success',
            error: 'text-danger',
            warning: 'text-warn',
            info: 'text-accent'
        };
        const toastClass = {
            success: 'tk-toast tk-toast-success',
            error: 'tk-toast tk-toast-error',
            warning: 'tk-toast tk-toast-warning',
            info: 'tk-toast tk-toast-info'
        };

        const toast = document.createElement('div');
        toast.className = toastClass[variant];
        toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
        toast.innerHTML =
            `<svg class="mt-0.5 h-4 w-4 flex-shrink-0 ${iconColour[variant]}" viewBox="0 0 24 24"`
            + ` fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"`
            + ` stroke-linejoin="round">${icons[variant]}</svg><span></span>`;
        toast.lastElementChild.textContent = message;

        // Add the toast to the container
        toastContainer.appendChild(toast);

        // Set a timeout to remove the toast
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(0.75rem)';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }

                // If no more toasts, remove the container
                if (toastContainer.children.length === 0) {
                    toastContainer.remove();
                }
            }, 300);
        }, 3000);
    }


    /** Escape a string for safe interpolation into innerHTML. */
    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    timeStringToMinutes(timeString) {
        if (!timeString) return 0;
        // Preserve the established whole-minute duration semantics: seconds in
        // API values never made a partial minute before this shared parser.
        return Math.floor(clockTimeToSeconds(timeString) / 60);
    }

    formatDurationMinutes(minutes) {
        return formatDurationMinutes(minutes);
    }

    totalTimeSpentToFractionalHours(minutes) {
        if (!this.roundingEnabled) return minutes / 60;

        const units = minutes / this.roundingIntervalMinutes;
        let roundedUnits;
        if (this.roundingDirection === 'up') roundedUnits = Math.ceil(units);
        else if (this.roundingDirection === 'down') roundedUnits = Math.floor(units);
        else roundedUnits = Math.floor(units + 0.5);

        return roundedUnits * this.roundingIntervalMinutes / 60;
    }

    formatDecimalHours(hours) {
        return formatDecimalHours(hours);
    }

    /**
     * Minutes a task ran. `/tasks/<date>` substitutes the current time for a
     * task that hasn't ended *today*, so an in-flight task measures up to now.
     * An open row on an earlier date reports its own start time and therefore
     * zero, until the startup sweep closes it properly — see day_close.js.
     */
    getMinuteDifference(endTime, startTime) {
        if (!endTime) return 0;
        return this.timeStringToMinutes(endTime) - this.timeStringToMinutes(startTime);
    }

    /**
     * The house format for a billable figure: policy-adjusted hours, the real
     * tracked time, and what rounding gave or took. With rounding disabled,
     * only the tracked duration is rendered.
     *
     *     3.5 hrs. · 3 hrs 20 mins · +10m
     *
     * Shared so the Today page and the Task Browser can't drift into showing
     * the same number two different ways.
     */
    formatTimeWithDifference(fractionalHours, totalMinutes, difference) {
        if (!this.roundingEnabled) {
            return this.formatDurationMinutes(totalMinutes);
        }

        const colorClass = difference > 0 ? 'text-success' : 'text-danger';
        const diffDisplay = difference !== 0
            ? `<span class="${colorClass} ml-1 text-xs font-medium">${difference > 0 ? '+' : '−'}${Math.abs(difference)}m</span>`
            : '';

        return `${this.formatDecimalHours(fractionalHours)}<span class="text-faint font-normal"> hrs.</span>`
            + `<span class="text-faint font-normal text-xs"> · ${this.formatDurationMinutes(totalMinutes)}</span>`
            + diffDisplay;
    }
}
