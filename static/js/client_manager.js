import {
    TimeKeeper,
    confirmAction,
    makeModalBackdropStatic,
    lockBodyScroll,
    ready,
    unlockBodyScroll,
} from './base.js';

/** Generate the same bright color family the server uses for automatic clients. */
export function randomClientColor() {
    let sample;
    if (globalThis.crypto?.getRandomValues) {
        const value = new Uint32Array(1);
        globalThis.crypto.getRandomValues(value);
        sample = value[0] / 0x100000000;
    } else {
        sample = Math.random();
    }

    const hue = sample * 360;
    const saturation = 0.62;
    const lightness = 0.58;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const section = hue / 60;
    const x = chroma * (1 - Math.abs(section % 2 - 1));
    const channels = section < 1 ? [chroma, x, 0]
        : section < 2 ? [x, chroma, 0]
            : section < 3 ? [0, chroma, x]
                : section < 4 ? [0, x, chroma]
                    : section < 5 ? [x, 0, chroma]
                        : [chroma, 0, x];
    const offset = lightness - chroma / 2;
    return `#${channels.map((channel) => Math.round((channel + offset) * 255)
        .toString(16).padStart(2, '0')).join('')}`;
}

export class ClientManager extends TimeKeeper {
    constructor() {
        super();
        this.editingId = null;
        this.modalOpener = null;
        this.initializeElements();
        this.bindEvents();
        this.updateClientListState();
    }

    initializeElements() {
        this.addButton = document.getElementById('add-client-button');
        this.modal = document.getElementById('client-form-modal');
        this.form = document.getElementById('client-form');
        this.title = document.getElementById('client-form-title');
        this.nameInput = document.getElementById('client-name');
        this.colorInput = document.getElementById('client-color');
        this.colorValue = document.getElementById('client-color-value');
        this.saveButton = document.getElementById('client-save');
        this.tbody = document.querySelector('.tk-client-table tbody');
        this.subtitle = document.querySelector('.tk-page-header .tk-subtitle');
        this.filterInput = document.getElementById('client-filter');
        this.emptyState = document.getElementById('client-empty-state');
        this.filterEmptyState = document.getElementById('client-filter-empty');
    }

    bindEvents() {
        this.addButton.addEventListener('click', () => this.openAddModal());
        this.form.addEventListener('submit', (event) => this.saveClient(event));
        this.colorInput.addEventListener('input', () => this.updateColorValue());
        // This is intentionally a local name filter. It neither calls the
        // history APIs nor keeps a list of previous searches.
        this.filterInput.addEventListener('input', () => this.updateClientListState());
        this.filterInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !this.filterInput.value) return;
            event.stopPropagation();
            this.filterInput.value = '';
            this.updateClientListState();
        });

        document.querySelectorAll('[data-close-client-modal]').forEach((button) => {
            button.addEventListener('click', () => this.closeModal());
        });
        makeModalBackdropStatic(this.modal);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.modal.classList.contains('hidden')) {
                this.closeModal();
            }
        });

        this.tbody.addEventListener('click', (event) => {
            const button = event.target.closest('button[name]');
            const row = button?.closest('tr[data-client-id]');
            if (!button || !row) return;

            if (button.name === 'edit') {
                this.openEditModal(row, button);
            } else if (button.name === 'delete') {
                confirmAction(button, () => this.deleteClient(row));
            }
        });
    }

    openAddModal() {
        this.editingId = null;
        this.modalOpener = this.addButton;
        this.title.textContent = 'Add client';
        this.saveButton.textContent = 'Add client';
        this.nameInput.value = '';
        this.colorInput.value = randomClientColor();
        this.updateColorValue();
        this.showModal();
    }

    openEditModal(row, opener) {
        this.editingId = row.dataset.clientId;
        this.modalOpener = opener;
        this.title.textContent = 'Edit client';
        this.saveButton.textContent = 'Save changes';
        this.nameInput.value = row.dataset.clientName;
        this.colorInput.value = row.dataset.clientColor;
        this.updateColorValue();
        this.showModal();
    }

    showModal() {
        if (!this.modal.classList.contains('hidden')) return;
        this.modal.classList.remove('hidden');
        lockBodyScroll();
        requestAnimationFrame(() => {
            this.nameInput.focus();
            this.nameInput.select();
        });
    }

    closeModal({ restoreFocus = true } = {}) {
        if (this.modal.classList.contains('hidden')) return;
        this.modal.classList.add('hidden');
        unlockBodyScroll();
        this.editingId = null;
        this.saveButton.disabled = false;
        if (restoreFocus && this.modalOpener?.isConnected) this.modalOpener.focus();
        this.modalOpener = null;
    }

    updateColorValue() {
        this.colorValue.value = this.colorInput.value.toUpperCase();
        this.colorValue.textContent = this.colorValue.value;
    }

    async saveClient(event) {
        event.preventDefault();
        const name = this.nameInput.value.trim();
        if (!name) {
            this.showToast('Client name cannot be empty', 'warning');
            this.nameInput.focus();
            return;
        }

        const editingId = this.editingId;
        this.saveButton.disabled = true;
        try {
            const client = await this.fetchFromAPI(
                editingId ? `/clients/${editingId}` : '/clients',
                {
                    method: editingId ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, color: this.colorInput.value }),
                },
            );

            if (editingId) this.updateClientRow(client);
            else this.addClientRow(client);
            this.closeModal({ restoreFocus: false });
            this.showToast(editingId ? 'Client updated successfully' : 'Client created successfully');
        } catch (error) {
            console.error('Could not save client:', error);
            this.saveButton.disabled = false;
        }
    }

    updateClientRow(client) {
        const row = document.getElementById(`row_${client.id}`);
        if (!row) return;
        row.dataset.clientName = client.name;
        row.dataset.clientColor = client.color;
        row.querySelector('[data-client-name-cell]').textContent = client.name;
        row.querySelector('.tk-client-swatch').style.backgroundColor = client.color;
        this.updateClientListState();
        row.classList.remove('tk-row-new');
        void row.offsetWidth;
        row.classList.add('tk-row-new');
        setTimeout(() => row.classList.remove('tk-row-new'), 1500);
    }

    addClientRow(client) {
        const row = document.createElement('tr');
        row.id = `row_${client.id}`;
        row.dataset.clientId = client.id;
        row.dataset.clientName = client.name;
        row.dataset.clientColor = client.color;
        row.className = 'tk-row-new';
        row.innerHTML = `
            <td class="hidden">${client.id}</td>
            <td><span class="tk-client-swatch" style="background-color: ${client.color}"></span></td>
            <td class="font-medium" data-client-name-cell>${this.escapeHtml(client.name)}</td>
            <td class="text-right">
                <div class="tk-client-actions">
                    <button name="edit" class="tk-btn tk-btn-secondary tk-btn-sm">Edit</button>
                    <button name="delete" class="tk-btn tk-btn-danger tk-btn-sm">Delete</button>
                </div>
            </td>
        `;
        this.tbody.insertBefore(row, this.emptyState);
        this.updateClientListState();
        setTimeout(() => row.classList.remove('tk-row-new'), 1500);
    }

    async deleteClient(row) {
        const id = row.dataset.clientId;
        try {
            row.classList.add('tk-row-removing');
            await this.fetchFromAPI(`/clients/${id}`, { method: 'DELETE' });

            row.querySelectorAll('td').forEach((cell) => {
                cell.style.paddingTop = '0';
                cell.style.paddingBottom = '0';
                cell.style.lineHeight = '0';
                cell.style.overflow = 'hidden';
            });
            setTimeout(() => {
                row.remove();
                this.updateClientListState();
            }, 500);
            this.showToast('Client deleted successfully');
        } catch (error) {
            console.error('Could not delete client:', error);
            row.classList.remove('tk-row-removing');
        }
    }

    updateClientListState() {
        const rows = [...this.tbody.querySelectorAll('tr[data-client-id]')];
        const query = this.filterInput.value.trim().toLocaleLowerCase();
        let visible = 0;

        rows.forEach((row) => {
            const matches = !query
                || row.dataset.clientName.toLocaleLowerCase().includes(query);
            row.classList.toggle('hidden', !matches);
            if (matches) visible++;
        });

        const total = rows.length;
        this.emptyState.classList.toggle('hidden', total !== 0);
        this.filterEmptyState.classList.toggle(
            'hidden', total === 0 || !query || visible !== 0,
        );
        this.subtitle.textContent = query
            ? `${visible} of ${total} clients`
            : `${total} client${total === 1 ? '' : 's'}`;
    }
}

ready(() => new ClientManager());
