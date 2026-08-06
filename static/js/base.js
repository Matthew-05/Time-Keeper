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

    async fetchFromAPI(endpoint, options = {}) {
        try {
            const response = await fetch(endpoint, options);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            this.showToast(error.message, 'red');
            throw error;
        }
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
