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

/**
 * One delegated popover for every insight control and budget meter in the app.
 * Delegation also covers elements rendered after page load.
 */
function bindInsightPopovers() {
    const popover = document.createElement('div');
    popover.className = 'tk-insight-popover hidden';
    popover.setAttribute('role', 'tooltip');
    document.body.appendChild(popover);

    const show = (target) => {
        // Measured *after* the content is in, because a structured insight is
        // several lines tall and the old single-line height would place it
        // overlapping the control it describes.
        renderInsight(popover, target.dataset.insight);
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
    };
    const hide = () => popover.classList.add('hidden');

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
 * Stable per-client colour, shared by the History timeline and the Summary
 * charts.
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
export function clientColor(name) {
    const key = String(name ?? '');
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
    }
    return `hsl(${Math.abs(hash) % 360}, 62%, 58%)`;
}

/**
 * Readable foreground paired with clientColor(). The generated background has
 * fixed saturation/lightness, so deriving its RGB luminance from the same
 * stable hue lets History choose the stronger of a light or dark label without
 * depending on the current theme.
 */
export function clientForeground(name) {
    const match = clientColor(name).match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    const hue = Number(match[1]) / 360;
    const saturation = Number(match[2]) / 100;
    const lightness = Number(match[3]) / 100;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const section = hue * 6;
    const x = chroma * (1 - Math.abs(section % 2 - 1));
    const channels = section < 1 ? [chroma, x, 0]
        : section < 2 ? [x, chroma, 0]
            : section < 3 ? [0, chroma, x]
                : section < 4 ? [0, x, chroma]
                    : section < 5 ? [x, 0, chroma]
                        : [chroma, 0, x];
    const offset = lightness - chroma / 2;
    const luminance = channels
        .map((channel) => channel + offset)
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
     * task that hasn't ended, so an in-flight task measures up to now.
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
