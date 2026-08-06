import { TimeKeeper, ready } from './base.js';

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
        row.querySelector('[name="save"]').style.display = "inline-flex";
        row.querySelector('[name="cancel"]').style.display = "inline-flex";

        // Enable content editing for the name field
        const nameCell = document.getElementById(`name_${id}`);
        nameCell.contentEditable = "true";

        // Apply edit styling
        nameCell.classList.add('tk-cell-editing');

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

        // Flash the cell to acknowledge the cancel. Reads the live token values
        // so it tracks the current theme.
        const css = getComputedStyle(document.documentElement);
        nameCell.animate(
            [
                { backgroundColor: css.getPropertyValue('--danger-soft').trim() },
                { backgroundColor: 'transparent' }
            ],
            { duration: 600, easing: 'ease-out' }
        );

        this.resetRow(id);
    }

    enterDeleteConfirmMode(button, id) {
        // Store original text and styling
        button.dataset.originalText = button.textContent;
        button.dataset.confirmMode = 'true';
        
        // Change button appearance to confirm state
        button.textContent = 'Confirm?';
        button.classList.remove('tk-btn-danger');
        button.classList.add('tk-btn-danger-armed');
        
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
        button.classList.remove('tk-btn-danger-armed');
        button.classList.add('tk-btn-danger');
    }

    resetRow(id) {
        const row = document.getElementById(`row_${id}`);
        const nameCell = document.getElementById(`name_${id}`);

        // Remove editable styling from the name cell
        nameCell.classList.remove('tk-cell-editing');

        // Disable content editing for the name field
        nameCell.contentEditable = "false";

        // Reset button visibility
        row.querySelectorAll('[name="edit"], [name="delete"]')
            .forEach((btn) => (btn.style.display = "inline-flex"));
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
            row.classList.add('tk-row-removing');

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
                        <td colspan="2" class="tk-empty">No clients yet. Add your first one above.</td>
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
            if (row) row.classList.remove('tk-row-removing');
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
        newRow.className = 'tk-row-new';

        newRow.innerHTML = `
            <td class="hidden">${client.id}</td>
            <td id="name_${client.id}" contenteditable="false" class="font-medium transition-colors">${this.escapeHtml(client.name)}</td>
            <td class="text-right">
                <div class="flex justify-end gap-1.5">
                    <button name="edit" class="tk-btn tk-btn-secondary tk-btn-sm">Edit</button>
                    <button name="delete" class="tk-btn tk-btn-danger tk-btn-sm">Delete</button>
                    <button name="save" style="display: none" class="tk-btn tk-btn-primary tk-btn-sm">Save</button>
                    <button name="cancel" style="display: none" class="tk-btn tk-btn-secondary tk-btn-sm">Cancel</button>
                </div>
            </td>
        `;

        tbody.appendChild(newRow);

        // Store the original text
        this.originalText[`name_${client.id}`] = client.name;

        // .tk-row-new plays the highlight; drop it once it's finished so the
        // row picks up normal hover styling again.
        setTimeout(() => newRow.classList.remove('tk-row-new'), 1500);
    }
}

// Initialize the client manager once the DOM is ready
ready(() => {
    new ClientManager();
});
