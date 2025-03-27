export class TimeKeeper {
    constructor() {
        this.ensureToastContainer();

    }

    ensureToastContainer() {
        if (!document.getElementById('toast-container')) {
            const toastContainer = document.createElement('div');
            toastContainer.id = 'toast-container';
            toastContainer.className = 'fixed bottom-4 right-4 flex flex-col-reverse space-y-reverse space-y-2 z-50';
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

        const toastClasses = {
            success: 'bg-green-500',
            error: 'bg-red-500',
            warning: 'bg-yellow-500',
            yellow: 'bg-yellow-500', // For backward compatibility
            red: 'bg-red-500',       // For backward compatibility
            green: 'bg-green-500'    // For backward compatibility
        };

        const toast = document.createElement('div');
        toast.className = `px-6 py-3 rounded-lg text-white ${toastClasses[type] || 'bg-blue-500'} shadow-lg transition-all duration-300 mb-2`;
        toast.textContent = message;

        // Add the toast to the container
        toastContainer.appendChild(toast);

        // Set a timeout to remove the toast
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
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
