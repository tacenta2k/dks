import { useEffect, useState } from 'react';

import { calculateDaysLeft, isValidIsoDate } from '../../lib/date';

export interface RenewModalProps {
  rowLabel: string;
  currentExpiry?: string | null;
  today?: string | Date;
  onCancel: () => void;
  onConfirm: (nextExpiry: string) => void | Promise<void>;
}

function todayIso(today?: string | Date): string {
  if (typeof today === 'string' && isValidIsoDate(today)) {
    return today;
  }
  const date = today instanceof Date ? today : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function defaultFutureExpiry(today?: string | Date): string {
  const base = todayIso(today).split('-').map(Number);
  const date = new Date(base[0], base[1] - 1, base[2]);
  date.setFullYear(date.getFullYear() + 1);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('-');
}

export function validateRenewalDate(value: string, today?: string | Date): string | null {
  if (!isValidIsoDate(value)) {
    return 'Enter a valid ISO date (YYYY-MM-DD).';
  }
  if ((calculateDaysLeft(value, today) ?? 0) <= 0) {
    return 'Choose a future expiry date.';
  }
  return null;
}

export function RenewModal({
  rowLabel,
  currentExpiry,
  today,
  onCancel,
  onConfirm,
}: RenewModalProps) {
  const [nextExpiry, setNextExpiry] = useState(defaultFutureExpiry(today));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNextExpiry(defaultFutureExpiry(today));
    setError(null);
  }, [rowLabel, today]);

  const submit = () => {
    const validationError = validateRenewalDate(nextExpiry, today);
    if (validationError) {
      setError(validationError);
      return;
    }
    void onConfirm(nextExpiry);
  };

  return (
    <div className="sheet-modal-backdrop">
      <section className="sheet-modal" role="dialog" aria-modal="true" aria-label="Mark row renewed">
        <div className="sheet-modal__header">
          <div>
            <p className="sheet-eyebrow">Renewal</p>
            <h2>Mark row renewed</h2>
            <p className="sheet-modal__description">Update the expiry for {rowLabel}.</p>
          </div>
          <button className="sheet-modal__close" type="button" aria-label="Close renewal dialog" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="sheet-form">
          <p className="sheet-form__hint">Current expiry: {currentExpiry || 'No expiry'}</p>
          <label>
            New expiry date
            <input
              type="date"
              value={nextExpiry}
              onChange={(event) => {
                setNextExpiry(event.target.value);
                setError(null);
              }}
            />
          </label>
          {error ? <p className="sheet-form__error" role="alert">{error}</p> : null}
          <div className="sheet-modal__actions">
            <button className="button" type="button" onClick={onCancel}>Cancel</button>
            <button className="button button--primary" type="button" onClick={submit}>Save renewal</button>
          </div>
        </div>
      </section>
    </div>
  );
}
