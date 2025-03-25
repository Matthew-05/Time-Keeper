export class TimeKeeper {
    constructor() {
        this.initializeElements();
    }

    initializeElements() {
        // Initialize any common elements or event listeners
        document.addEventListener('DOMContentLoaded', () => {
            this.init?.();
        });
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
        const toastClasses = {
            success: 'bg-green-500',
            error: 'bg-red-500',
            warning: 'bg-yellow-500'
        };

        const toast = document.createElement('div');
        toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg text-white ${toastClasses[type]} transition-opacity duration-300`;
        toast.textContent = message;

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
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
