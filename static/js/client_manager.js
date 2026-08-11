import { TimeKeeper, confirmAction, ready } from './base.js';

export class ClientManager extends TimeKeeper {
    constructor() {
        super();
        this.originalText = {};
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
        document.addEventListener('keydown', (e) => this.handleEditKeydown(e));

        // contenteditable accepts pasted markup; strip it back to plain text.
        document.addEventListener('paste', (e) => {
            if (!e.target.closest?.('.tk-editable.is-editing')) return;
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData)
                .getData('text/plain')
                .replace(/\s+/g, ' ');
            document.execCommand('insertText', false, text);
        });

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
                confirmAction(target, () => this.deleteClient(id));
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

    /* Flash a cell's background with a themed token. Reads the live variable so
       the animation follows the current theme. */
    flashCell(cell, token) {
        const value = getComputedStyle(document.documentElement)
            .getPropertyValue(token)
            .trim();
        cell.animate(
            [{ backgroundColor: value }, { backgroundColor: 'transparent' }],
            { duration: 600, easing: 'ease-out' }
        );
    }

    editClient(id) {
        // Hide edit and delete buttons, show save and cancel buttons for this row only
        const row = document.getElementById(`row_${id}`);
        row.querySelectorAll('[name="edit"], [name="delete"]')
            .forEach((btn) => (btn.style.display = "none"));
        row.querySelector('[name="save"]').style.display = "inline-flex";
        row.querySelector('[name="cancel"]').style.display = "inline-flex";
        row.classList.add('tk-row-editing');

        // Turn the name into a field. .is-editing carries the input styling;
        // the transition on .tk-editable animates the change.
        const nameCell = document.getElementById(`name_${id}`);
        nameCell.contentEditable = "true";
        nameCell.classList.add('is-editing');

        // Set focus and select all text
        nameCell.focus();

        // Create a range and select all text
        const range = document.createRange();
        range.selectNodeContents(nameCell);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }

    /* Enter commits, Escape reverts — matches what a real input would do. */
    handleEditKeydown(event) {
        const cell = event.target.closest?.('.tk-editable.is-editing');
        if (!cell) return;

        const id = cell.id.split('_')[1];

        if (event.key === 'Enter') {
            event.preventDefault();
            this.saveEdit(id);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            this.cancelEdit(id);
        } else {
            cell.classList.remove('is-invalid');
        }
    }

    markInvalid(cell) {
        cell.classList.remove('is-invalid');
        // Force a reflow so the nudge animation restarts on repeat attempts.
        void cell.offsetWidth;
        cell.classList.add('is-invalid');
        cell.focus();
    }

    async saveEdit(id) {
        const nameCell = document.getElementById(`name_${id}`);
        const newName = nameCell.innerText.trim();

        if (!newName) {
            this.showToast('Client name cannot be empty', 'warning');
            this.markInvalid(nameCell);
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

            this.showToast('Client updated successfully');
            this.resetRow(id);
            this.flashCell(nameCell, '--success-soft');
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

        this.resetRow(id);
        this.flashCell(nameCell, '--danger-soft');
    }

    resetRow(id) {
        const row = document.getElementById(`row_${id}`);
        const nameCell = document.getElementById(`name_${id}`);

        // Remove editable styling from the name cell
        nameCell.classList.remove('is-editing', 'is-invalid');
        row.classList.remove('tk-row-editing');

        // Disable content editing for the name field
        nameCell.contentEditable = "false";
        nameCell.blur();

        // Reset button visibility
        row.querySelectorAll('[name="edit"], [name="delete"]')
            .forEach((btn) => (btn.style.display = "inline-flex"));
        row.querySelector('[name="save"]').style.display = "none";
        row.querySelector('[name="cancel"]').style.display = "none";
    }

    async deleteClient(id) {
        try {
            const row = document.getElementById(`row_${id}`);

            // Add delete animation
            row.classList.add('tk-row-removing');

            await this.fetchFromAPI(`/clients/${id}`, {
                method: "DELETE",
            });

            // Animate row removal. Height/padding/margin on the <tr> itself do
            // nothing — the cells carry .tk-table's padding and set the row's
            // height — so collapse the cells instead.
            row.querySelectorAll("td").forEach((cell) => {
                cell.style.paddingTop = "0";
                cell.style.paddingBottom = "0";
                cell.style.lineHeight = "0";
                cell.style.overflow = "hidden";
            });

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
            <td class="font-medium">
                <span id="name_${client.id}" class="tk-editable" contenteditable="false" spellcheck="false">${this.escapeHtml(client.name)}</span>
            </td>
            <td class="text-right">
                <div class="flex min-h-8 items-center justify-end gap-1.5">
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
