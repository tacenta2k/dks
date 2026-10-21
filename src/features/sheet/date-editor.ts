import type { ICellEditorComp, ICellEditorParams } from 'ag-grid-community';

import { formatDateTyping, formatDisplayDate, toStorableDateValue } from '../../lib/date';

/**
 * Cell editor for date columns. Values are displayed and typed as
 * DD/MM/YYYY with progressive slash insertion; the committed value is the
 * storage form (YYYY-MM-DD) or the untouched text when the date is impossible.
 */
export class DateCellEditor implements ICellEditorComp {
  private gui!: HTMLInputElement;
  private params!: ICellEditorParams;

  init(params: ICellEditorParams): void {
    this.params = params;
    const gui = document.createElement('input');
    gui.type = 'text';
    gui.className = 'dks-date-editor';
    gui.placeholder = 'DD/MM/YYYY';
    gui.setAttribute('aria-label', 'Date (DD/MM/YYYY)');
    gui.value = typeof params.value === 'string' && params.value.trim()
      ? formatDisplayDate(params.value)
      : '';
    gui.addEventListener('input', this.handleInput);
    gui.addEventListener('keydown', this.handleKeyDown);
    this.gui = gui;
  }

  private handleInput = (): void => {
    const formatted = formatDateTyping(this.gui.value);
    if (formatted !== this.gui.value) {
      const caretAtEnd = this.gui.selectionStart === this.gui.value.length;
      this.gui.value = formatted;
      if (caretAtEnd) {
        this.gui.setSelectionRange(formatted.length, formatted.length);
      }
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      this.params.stopEditing();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.params.api.stopEditing(true);
    }
  };

  getGui(): HTMLElement {
    return this.gui;
  }

  afterGuiAttached(): void {
    this.gui.focus();
    this.gui.select();
  }

  getValue(): string {
    const stored = toStorableDateValue(this.gui.value);
    return stored === null || stored === undefined ? '' : String(stored);
  }

  focusIn(): void {
    this.gui.focus();
    this.gui.select();
  }

  isPopup(): boolean {
    return false;
  }
}
