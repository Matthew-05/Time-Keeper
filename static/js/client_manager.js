import { TimeKeeper } from './base.js';

export class ClientManager extends TimeKeeper {
    constructor() {
        super();
        this.originalText = {};
        this.deleteConfirmTimers = {};
        this.initializeElements();
        this.bindEvents();
        this.initOriginalText();
    }

    initializeElements() {
        this.createForm = document.getElementById('create-form');
        this.newClientNameInput = document.getElementById('new-client-name');
    }

    bindEvents() {
        this.createForm.addEventListener('submit', (e) => this.createClient(e));

        // Add event listeners for edit, delete, save, and cancel buttons
        document.addEventListener('click', (e) => {
            const target = e.target;

            if (target.name === 'edit') {
                const row = target.closest('tr');
                const id = row.id.split('_')[1];
                this.editClient(id);
            } else if (target.name === 'delete') {
                const row = target.closest('tr');
                const id = row.id.split('_')[1];
                
                // Check if this is already in confirm mode
                if (target.dataset.confirmMode === 'true') {
                    // Actually delete the client
                    this.deleteClient(id);
                } else {
                    // Enter confirm mode
                    this.enterDeleteConfirmMode(target, id);
                }
            } else if (target.name === 'save') {
                const row = target.closest('tr');
                const id = row.id.split('_')[1];
                this.saveEdit(id);
            } else if (target.name === 'cancel') {
                const row = target.closest('tr');
                const id = row.id.split('_')[1];
                this.cancelEdit(id);
            }
        });
    }

    initOriginalText() {
        const nameCells = document.querySelectorAll('[id^="name_"]');
        nameCells.forEach((cell) => {
            this.originalText[cell.id] = cell.innerText;
        });
    }

    editClient(id) {
        // Hide edit and delete buttons, show save and cancel buttons for this row only
        const row = document.getElementById(`row_${id}`);
        row.querySelectorAll('[name="edit"], [name="delete"]')
            .forEach((btn) => (btn.style.display = "none"));
        row.querySelector('[name="save"]').style.display = "inline-block";
        row.querySelector('[name="cancel"]').style.display = "inline-block";

        // Enable content editing for the name field
        const nameCell = document.getElementById(`name_${id}`);
        nameCell.contentEditable = "true";

        // Apply edit styling
        nameCell.classList.add(
            'bg-blue-50',
            'border-2',
            'border-blue-300',
            'rounded-md',
            'shadow-inner',
            'px-3',
            'py-2',
            'focus:outline-none',
            'focus:ring-2',
            'focus:ring-blue-300',
            'focus:border-blue-400'
        );

        // Set focus and select all text
        nameCell.focus();

        // Create a range and select all text
        const range = document.createRange();
        range.selectNodeContents(nameCell);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        // Add a highlight animation
        nameCell.animate(
            [
                { backgroundColor: '#EFF6FF' }, // blue-50
                { backgroundColor: '#DBEAFE' }, // blue-100
                { backgroundColor: '#EFF6FF' }  // blue-50
            ],
            {
                duration: 600,
                easing: 'ease-in-out'
            }
        );
    }

    async saveEdit(id) {
        const nameCell = document.getElementById(`name_${id}`);
        const newName = nameCell.innerText.trim();

        if (!newName) {
            this.showToast('Client name cannot be empty', 'warning');
            nameCell.focus();
            return;
        }

        try {
            await this.fetchFromAPI(`/clients/${id}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ name: newName }),
            });

            // Success animation
            nameCell.animate(
                [
                    { backgroundColor: '#EFF6FF' }, // blue-50
                    { backgroundColor: '#DCFCE7' }, // green-50
                    { backgroundColor: 'white' }
                ],
                {
                    duration: 800,
                    easing: 'ease-out'
                }
            );

            this.showToast('Client updated successfully');
            this.resetRow(id);
            // Update the original text with the new value
            this.originalText[`name_${id}`] = newName;
        } catch (error) {
            this.showToast('Failed to update client', 'error');
            console.error("Error:", error);
        }
    }

    cancelEdit(id) {
        // Reset the row to original state
        const nameCell = document.getElementById(`name_${id}`);
        nameCell.innerText = this.originalText[nameCell.id];

        // Add a cancel animation
        nameCell.animate(
            [
                { backgroundColor: '#EFF6FF' }, // blue-50
                { backgroundColor: '#FEF2F2' }, // red-50
                { backgroundColor: 'white' }
            ],
            {
                duration: 600,
                easing: 'ease-out'
            }
        );

        this.resetRow(id);
    }

    enterDeleteConfirmMode(button, id) {
        // Store original text and styling
        button.dataset.originalText = button.textContent;
        button.dataset.confirmMode = 'true';
        
        // Change button appearance to confirm state
        button.textContent = 'Confirm Delete?';
        button.classList.remove('text-red-600', 'hover:text-red-900', 'bg-red-50', 'hover:bg-red-100');
        button.classList.add('text-white', 'bg-red-600', 'hover:bg-red-700', 'font-semibold', 'animate-pulse');
        
        // Clear any existing timer for this button
        if (this.deleteConfirmTimers[id]) {
            clearTimeout(this.deleteConfirmTimers[id]);
        }
        
        // Set timer to revert after 3 seconds
        this.deleteConfirmTimers[id] = setTimeout(() => {
            this.revertDeleteButton(button);
            delete this.deleteConfirmTimers[id];
        }, 3000);
    }
    
    revertDeleteButton(button) {
        // Revert button to original state
        button.textContent = button.dataset.originalText || 'Delete';
        button.dataset.confirmMode = 'false';
        
        // Restore original styling
        button.classList.remove('text-white', 'bg-red-600', 'hover:bg-red-700', 'font-semibold', 'animate-pulse');
        button.classList.add('text-red-600', 'hover:text-red-900', 'bg-red-50', 'hover:bg-red-100');
    }

    resetRow(id) {
        const row = document.getElementById(`row_${id}`);
        const nameCell = document.getElementById(`name_${id}`);

        // Remove editable styling from the name cell
        nameCell.classList.remove(
            'bg-blue-50',
            'border-2',
            'border-blue-300',
            'rounded-md',
            'shadow-inner',
            'px-3',
            'py-2',
            'focus:outline-none',
            'focus:ring-2',
            'focus:ring-blue-300',
            'focus:border-blue-400'
        );

        // Disable content editing for the name field
        nameCell.contentEditable = "false";

        // Reset button visibility
        row.querySelectorAll('[name="edit"], [name="delete"]')
            .forEach((btn) => (btn.style.display = "inline-block"));
        row.querySelector('[name="save"]').style.display = "none";
        row.querySelector('[name="cancel"]').style.display = "none";
    }

    async deleteClient(id) {
        // Clear the confirmation timer
        if (this.deleteConfirmTimers[id]) {
            clearTimeout(this.deleteConfirmTimers[id]);
            delete this.deleteConfirmTimers[id];
        }
        
        try {
            const row = document.getElementById(`row_${id}`);

            // Add delete animation
            row.style.transition = "all 0.5s ease";
            row.style.backgroundColor = "#FEE2E2"; // red-100
            row.style.opacity = "0.5";

            await this.fetchFromAPI(`/clients/${id}`, {
                method: "DELETE",
            });

            // Animate row removal
            row.style.height = "0";
            row.style.padding = "0";
            row.style.margin = "0";
            row.style.overflow = "hidden";

            setTimeout(() => {
                row.remove();
                
                // Check if table is now empty and show "No clients found" message
                const tbody = document.querySelector('tbody');
                const remainingRows = tbody.querySelectorAll('tr[id^="row_"]');
                if (remainingRows.length === 0) {
                    const emptyRow = document.createElement('tr');
                    emptyRow.innerHTML = `
                        <td colspan="2" class="px-6 py-8 text-center text-gray-500">
                            No clients found. Add your first client using the form above.
                        </td>
                    `;
                    tbody.appendChild(emptyRow);
                }
            }, 500);

            this.showToast('Client deleted successfully');
        } catch (error) {
            this.showToast('Failed to delete client', 'error');
            console.error("Error:", error);

            // Reset the row if delete fails
            const row = document.getElementById(`row_${id}`);
            if (row) {
                row.style.backgroundColor = "";
                row.style.opacity = "";
            }
        }
    }

    async createClient(event) {
        event.preventDefault();

        const clientName = this.newClientNameInput.value.trim();
        if (!clientName) {
            this.showToast('Client name cannot be empty', 'warning');
            this.newClientNameInput.focus();
            return;
        }

        try {
            const newClient = await this.fetchFromAPI("/clients", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ name: clientName }),
            });

            this.showToast('Client created successfully');

            // Clear the input field
            this.newClientNameInput.value = '';

            // Add a new row to the table instead of reloading
            this.addNewClientRow(newClient);
        } catch (error) {
            this.showToast('Failed to create client', 'error');
            console.error("Error:", error);
        }
    }

    addNewClientRow(client) {
        const tbody = document.querySelector('tbody');
        
        // Remove "No clients found" message if it exists
        const emptyMessage = tbody.querySelector('td[colspan="2"]');
        if (emptyMessage) {
            emptyMessage.closest('tr').remove();
        }
        
        const newRow = document.createElement('tr');
        newRow.id = `row_${client.id}`;
        newRow.className = 'bg-green-50';

        newRow.innerHTML = `
            <td class="hidden">${client.id}</td>
            <td id="name_${client.id}" contenteditable="false" class="px-6 py-4 text-sm text-gray-900 transition-all duration-200">
                ${client.name}
            </td>
            <td class="px-6 py-4 text-right text-sm font-medium space-x-2">
                <button name="edit" class="text-blue-600 hover:text-blue-900 bg-blue-50 hover:bg-blue-100 px-3 py-1 rounded-md transition-colors">
                    Edit
                </button>
                <button name="delete" class="text-red-600 hover:text-red-900 bg-red-50 hover:bg-red-100 px-3 py-1 rounded-md transition-colors">
                    Delete
                </button>
                <button name="save" style="display: none" class="text-green-600 hover:text-green-900 bg-green-50 hover:bg-green-100 px-3 py-1 rounded-md transition-colors">
                    Save
                </button>
                <button name="cancel" style="display: none" class="text-gray-600 hover:text-gray-900 bg-gray-50 hover:bg-gray-100 px-3 py-1 rounded-md transition-colors">
                    Cancel
                </button>
            </td>
        `;

        tbody.appendChild(newRow);

        // Store the original text
        this.originalText[`name_${client.id}`] = client.name;

        // Add a highlight animation for the new row
        setTimeout(() => {
            newRow.style.transition = "background-color 1s ease";
            newRow.style.backgroundColor = "white";
        }, 100);
    }
}

// Initialize the client manager when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    const clientManager = new ClientManager();
});
