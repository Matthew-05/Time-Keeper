export class TimeKeeper {
    constructor() {
        this.initializeMaterialize();
    }

    initializeMaterialize() {
        document.addEventListener('DOMContentLoaded', () => {
            // Initialize all Materialize components that might be used across pages
            M.AutoInit();
        });
    }

    // Utility methods used across multiple pages
    getCurrentTimeIn12HourFormat() {
        const now = new Date();
        let hours = now.getHours();
        let minutes = now.getMinutes();
        let ampm = hours >= 12 ? 'PM' : 'AM';

        hours = hours % 12;
        hours = hours ? hours : 12;
        hours = hours < 10 ? '' + hours : hours;
        minutes = minutes < 10 ? '0' + minutes : minutes;

        return `${hours}:${minutes} ${ampm}`;
    }

    // API methods used across multiple pages
    async fetchFromAPI(endpoint, options = {}) {
        try {
            const response = await fetch(endpoint, options);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    }

    showToast(message, classes = 'green') {
        M.toast({ html: message, classes: classes });
    }

    timeStringToMinutes(time) {
        const [hoursStr, minutesStr] = time.split(':');
        const hours = parseInt(hoursStr, 10);
        const minutes = parseInt(minutesStr, 10);
        return hours * 60 + minutes;
    }
}
