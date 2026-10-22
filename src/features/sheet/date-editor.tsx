import {
  forwardRef,
  type ChangeEvent,
  type Ref,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useGridCellEditor } from 'ag-grid-react';

import {
  formatDateTyping,
  formatDisplayDate,
  normalizeUserDateToIso,
  toStorableDateValue,
} from '../../lib/date';

export interface DateEditorRef {
  getValue(): string;
  afterGuiAttached(): void;
  focusIn(): void;
  isPopup(): boolean;
  isCancelAfterEnd(): boolean;
}

/**
 * Props for the DD/MM/YYYY cell editor.
 *
 * AG Grid v32 mounts React cell editors through its "reactive custom
 * components" layer (`reactiveCustomComponents` defaults to `true`). In that
 * mode the grid owns the edit value: it passes `value` / `initialValue` and
 * expects the editor to report every edit through `onValueChange`; the value
 * committed at the end comes from that channel, not from a ref's `getValue`.
 * The forwardRef handle below is kept as well so the editor also works when
 * mounted the classic way (and in component tests).
 */
export interface DateEditorProps {
  /** Current value of the cell being edited (storage form or legacy text). */
  value?: unknown;
  /** The value in the cell when editing started. */
  initialValue?: unknown;
  /** Must be called with the editor's value on every change (AG Grid v32). */
  onValueChange?: (value: string) => void;
}

const ALERT_HINT = 'Nonexistent date (e.g. 31/02/2004) — kept unchanged. Check the day/month.';

/**
 * Mask + paste normalization for the DD/MM/YYYY editor:
 * `10` → `10/`, `1001` → `10/01/`, `10012004` → `10/01/2004`,
 * `10-01-2004` / `2004-01-10` → `10/01/2004`. Impossible complete dates keep
 * their typed text (warned by the editor, never silently changed).
 */
export function formatDateTypingInput(raw: string): string {
  const text = raw.trim();
  const isoLike = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (isoLike) {
    const normalized = normalizeUserDateToIso(text);
    if (normalized.iso) {
      return formatDisplayDate(normalized.iso);
    }
    // Impossible ISO-shaped input (e.g. 2004-02-31): show as DD/MM/YYYY text.
    return `${isoLike[3].padStart(2, '0')}/${isoLike[2].padStart(2, '0')}/${isoLike[1]}`;
  }
  return formatDateTyping(raw);
}

function displayTextFrom(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim() ? formatDateTypingInput(value) : '';
  }
  if (value) {
    return formatDisplayDate(new Date(value as string | number | Date));
  }
  return '';
}

function commitTextFrom(displayText: string): string {
  // Valid dates commit as storage form (YYYY-MM-DD); impossible dates keep
  // the typed text unchanged (warned, never silently changed).
  return String(toStorableDateValue(displayText) ?? '');
}

export const DateCellEditor = forwardRef<DateEditorRef, DateEditorProps>(
  function DateCellEditor(props: DateEditorProps, ref: Ref<DateEditorRef>) {
    const { value, onValueChange } = props;
    const [text, setText] = useState(() => displayTextFrom(value));
    const inputRef = useRef<HTMLInputElement | null>(null);
    const hint = normalizeUserDateToIso(text).impossible ? ALERT_HINT : '';

    function focusAndPlaceCaretAtEnd(): void {
      const input = inputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      const length = input.value.length;
      input.setSelectionRange(length, length);
    }

    function handleChange(event: ChangeEvent<HTMLInputElement>): void {
      const input = event.currentTarget;
      const caretAtEnd = input.selectionStart === input.value.length
        && input.selectionEnd === input.value.length;
      const formatted = formatDateTypingInput(input.value);
      input.value = formatted;
      setText(formatted);
      onValueChange?.(commitTextFrom(formatted));
      if (caretAtEnd) {
        requestAnimationFrame(() => {
          const current = inputRef.current;
          if (!current) {
            return;
          }
          const end = current.value.length;
          current.setSelectionRange(end, end);
        });
      }
    }

    // AG Grid v32 reactive custom component contract: the optional editor
    // callbacks are registered on the grid's editor proxy through this hook.
    // (The proxy owns `getValue` and reads it from the `onValueChange` feed.)
    useGridCellEditor({
      isCancelAfterEnd: () => false,
      focusIn: () => {
        inputRef.current?.select();
      },
      focusOut: () => undefined,
      afterGuiAttached: () => {
        focusAndPlaceCaretAtEnd();
      },
    } as Parameters<typeof useGridCellEditor>[0] & {
      afterGuiAttached?: () => void;
    });

    useImperativeHandle(ref, () => ({
      getValue(): string {
        const raw = inputRef.current ? inputRef.current.value : text;
        return commitTextFrom(raw);
      },
      afterGuiAttached() {
        focusAndPlaceCaretAtEnd();
      },
      focusIn() {
        inputRef.current?.select();
      },
      isPopup(): boolean {
        return false;
      },
      isCancelAfterEnd(): boolean {
        return false;
      },
    }));

    return (
      <div className="dks-date-editor">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          className="dks-date-editor__input"
          placeholder="DD/MM/YYYY"
          aria-label="Date (DD/MM/YYYY)"
          defaultValue={text}
          onChange={handleChange}
        />
        {hint ? <div role="alert" className="dks-date-editor__hint">{hint}</div> : null}
      </div>
    );
  },
);
