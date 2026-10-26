import { useMemo, useState, type FormEvent } from 'react';

import {
  COLUMN_TYPES,
  isReservedSystemColumnName,
  normalizeColumns,
  type ColumnDefinition,
  type ColumnType,
} from '../../lib/columns';
import type { ColumnInput } from './types';

export interface ColumnWizardProps {
  existingColumns?: readonly ColumnDefinition[];
  onSubmit: (column: ColumnDefinition) => void | Promise<void>;
  onClose: () => void;
}

function typeLabel(type: ColumnType): string {
  switch (type) {
    case 'date_start':
      return 'Date start';
    case 'date_expiry':
      return 'Date expiry';
    case 'phone':
      return 'Phone';
    case 'email':
      return 'Email';
    case 'price':
      return 'Price';
    case 'dropdown':
      return 'Dropdown';
    case 'checkbox':
      return 'Checkbox';
    case 'notes':
      return 'Notes';
    case 'civil_id':
      return 'Civil ID';
    case 'number':
      return 'Number';
    case 'text':
    default:
      return 'Text';
  }
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'column';
}

function nextColumnId(name: string, existingColumns: readonly ColumnDefinition[]): string {
  const used = new Set(existingColumns.map((column) => column.id));
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix++}`;
  }
  return candidate;
}

export function columnInputToDefinition(
  input: ColumnInput,
  existingColumns: readonly ColumnDefinition[] = [],
): ColumnDefinition {
  const column: ColumnDefinition = {
    id: input.id?.trim() || nextColumnId(input.name, existingColumns),
    name: input.name.trim(),
    type: input.type,
    ...(input.options ? { options: input.options } : {}),
    ...(input.isPassport || input.is_passport ? { isPassport: true, is_passport: true } : {}),
    position: existingColumns.length,
  };

  // normalizeColumns makes the first active date_expiry column the primary,
  // while keeping subsequent expiry columns available for display.
  return normalizeColumns([...existingColumns, column]).find((candidate) => candidate.id === column.id) ?? column;
}

export const createColumnDefinition = columnInputToDefinition;

export function ColumnWizard({
  existingColumns = [],
  onSubmit,
  onClose,
}: ColumnWizardProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ColumnType>('text');
  const [options, setOptions] = useState('');
  const [error, setError] = useState<string | null>(null);

  const optionValues = useMemo(() => Array.from(new Set(options
    .split(/[\n,]/)
    .map((option) => option.trim())
    .filter(Boolean))), [options]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Column name is required.');
      return;
    }
    // "Days Left" is reserved for the generated, read-only system column —
    // persisting a user column with that name/id produces a duplicate
    // right-pinned column that can never be deleted.
    if (isReservedSystemColumnName(trimmedName)) {
      setError('"Days Left" is a generated system column and cannot be added. Choose a different name.');
      return;
    }
    if (type === 'dropdown' && optionValues.length === 0) {
      setError('Add at least one dropdown option.');
      return;
    }

    const column = columnInputToDefinition({
      name: trimmedName,
      type,
      ...(type === 'dropdown' ? { options: optionValues } : {}),
    }, existingColumns);
    void onSubmit(column);
  };

  return (
    <div className="sheet-modal-backdrop">
      <section className="sheet-modal" role="dialog" aria-modal="true" aria-label="Add column">
        <div className="sheet-modal__header">
          <div>
            <p className="sheet-eyebrow">Column setup</p>
            <h2>Add column</h2>
          </div>
          <button className="sheet-modal__close" type="button" aria-label="Close add column" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="sheet-form" onSubmit={submit}>
          <label>
            Column name
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Passport number"
            />
          </label>
          <label>
            Column type
            <select value={type} onChange={(event) => setType(event.target.value as ColumnType)}>
              {COLUMN_TYPES.map((candidate) => (
                <option key={candidate} value={candidate}>{typeLabel(candidate)}</option>
              ))}
            </select>
          </label>
          {type === 'dropdown' ? (
            <label>
              Dropdown options
              <textarea
                value={options}
                onChange={(event) => setOptions(event.target.value)}
                placeholder="One option per line"
                rows={3}
              />
            </label>
          ) : null}
          {type === 'date_expiry' ? (
            <p className="sheet-form__hint">
              The first expiry column becomes the primary expiry used for Days Left.
            </p>
          ) : null}
          {error ? <p className="sheet-form__error" role="alert">{error}</p> : null}
          <div className="sheet-modal__actions">
            <button className="button" type="button" onClick={onClose}>Cancel</button>
            <button className="button button--primary" type="submit">Add column</button>
          </div>
        </form>
      </section>
    </div>
  );
}
