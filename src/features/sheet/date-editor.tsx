import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import {
  formatDateTyping,
  formatDisplayDate,
  normalizeUserDateToIso,
  toStorableDateValue,
} from '../../lib/date';

/**
 * Progressive DD/MM/YYYY masking for typing and pasting.
 *
 * Typing:   10 -> 10/ , 1001 -> 10/01/ , 10012004 -> 10/01/2004
 * Paste:    10012004 / 10-01-2004 -> 10/01/2004, 2004-01-10 -> 10/01/2004
 *
 * Impossible dates are kept exactly as typed (never silently changed).
 */
export function formatDateTypingInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed && /^\d{4}[-/.]/.test(trimmed)) {
    // ISO-shaped input (YYYY-MM-DD or similar): normalize to display form.
    const normalized = normalizeUserDateToIso(trimmed);
    return normalized.iso ? formatDisplayDate(normalized.iso) : value;
  }
  return formatDateTyping(value);
}

function isImpossibleDate(text: string): boolean {
  const trimmed = text.trim();
  // Only once the mask is complete (dd/mm/yyyy or dd/mm/yy): mid-typing
  // values like "10/" are incomplete, not invalid.
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(trimmed)
    && normalizeUserDateToIso(trimmed).impossible;
}

export interface DateEditorRef {
  getValue(): string;
  afterGuiAttached?(): void;
  focusIn?(): void;
  isPopup?(): boolean;
  isCancelAfterEnd?(): boolean;
}

interface DateEditorProps {
  value?: unknown;
  formatValue?: (value: unknown) => string;
  stopEditing?: () => void;
  api?: unknown;
}

/**
 * Date cell editor for AG Grid (React component — this grid instantiates
 * custom components as React components, so a vanilla ICellEditorComp is
 * never used). Displays and types DD/MM/YYYY; commits storage form
 * YYYY-MM-DD (or the untouched text when the date is impossible).
 */
export const DateCellEditor = forwardRef<DateEditorRef, DateEditorProps>(
  function DateCellEditor(props, ref) {
    const initial = typeof props.value === 'string' && props.value.trim()
      ? formatDisplayDate(props.value)
      : typeof props.value === 'number' && Number.isFinite(props.value)
        ? formatDisplayDate(String(props.value))
        : '';
    const [text, setText] = useState(initial);
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      getValue(): string {
        // Valid dates commit as storage form (YYYY-MM-DD); impossible dates
        // keep the typed text unchanged (warned, never silently changed).
        const raw = inputRef.current ? inputRef.current.value : text;
        return String(toStorableDateValue(raw) ?? '');
      },
      afterGuiAttached(): void {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
      focusIn(): void {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
      isPopup(): boolean {
        return false;
      },
      isCancelAfterEnd(): boolean {
        return false;
      },
    }));

    const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
      const formatted = formatDateTypingInput(event.target.value);
      if (formatted !== event.target.value) {
        const element = event.target;
        const caretAtEnd = element.selectionStart === element.value.length;
        element.value = formatted;
        if (caretAtEnd) {
          element.setSelectionRange(formatted.length, formatted.length);
        }
      }
      setText(event.target.value);
    };

    return (
      <div className="dks-date-editor">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          defaultValue={text}
          className="dks-date-editor__input"
          placeholder="DD/MM/YYYY"
          aria-label="Date (DD/MM/YYYY)"
          onChange={handleChange}
        />
        {isImpossibleDate(text) ? (
          <span className="dks-date-editor__hint" role="alert">
            Not a valid date — check DD/MM/YYYY (the text is kept unchanged)
          </span>
        ) : null}
      </div>
    );
  },
);
