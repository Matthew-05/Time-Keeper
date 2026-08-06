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

/** Surface anything that escapes a promise chain instead of failing silently. */
window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
});

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
 * Saturation and lightness are fixed rather than tokenised: these are
 * categorical chips with white text baked in, and they have to stay legible in
 * both themes without re-rendering on `themeChanged`.
 */
export function clientColor(name) {
    const key = String(name ?? '');
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
    }
    return `hsl(${Math.abs(hash) % 360}, 62%, 58%)`;
}

export class TimeKeeper {
    constructor() {
        this.ensureToastContainer();

    }

    ensureToastContainer() {
        if (!document.getElementById('toast-container')) {
            const toastContainer = document.createElement('div');
            toastContainer.id = 'toast-container';
            toastContainer.className = 'fixed bottom-9 right-4 z-50 flex flex-col-reverse gap-2';
            document.body.appendChild(toastContainer);
        }
    }

    getCurrentTimeIn12HourFormat() {
        const now = new Date();
        let hours = now.getHours();
        let minutes = now.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';

        hours = hours % 12 || 12;
        minutes = minutes.toString().padStart(2, '0');

        return `${hours}:${minutes} ${ampm}`;
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
                    throw new Error(`${response.status} ${response.statusText} — ${endpoint}`);
                }
                return await response.json();
            } catch (error) {
                lastError = error.name === 'AbortError'
                    ? new Error(`Request timed out after ${timeout}ms — ${endpoint}`)
                    : error;

                // Don't retry a request the caller deliberately cancelled.
                if (options.signal?.aborted) throw lastError;

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
        const [hours, minutes] = timeString.split(':').map(Number);
        return (hours * 60) + minutes;
    }

    minutesToHoursMinutes(minutes) {
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}:${remainingMinutes.toString().padStart(2, '0')}`;
    }

    totalTimeSpentToFractionalHours(minutes) {
        const hours = minutes / 60;
        return Math.round(hours * 4) / 4;
    }
}
