import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy. Keep it factual: what happens, and whether it can be undone. */
  children?: ReactNode;
  /** Label of the confirm button. Destructive actions use a red button. */
  confirmLabel: string;
  /** Optional extra prompt, e.g. "Type DELETE to confirm". */
  hint?: ReactNode;
  destructive?: boolean;
  busy?: boolean;
  /** Blocks the confirm button until it returns true (typed confirmation). */
  canConfirm?: boolean;
  /**
   * When set, the dialog shows a text input and the confirm button stays
   * disabled until the user types this exact value (mirrors the audit-log
   * clear gate, e.g. `requireText="DELETE"`).
   */
  requireText?: string;
  /** Accessible label for the typed-confirmation input. */
  requireTextLabel?: string;
  error?: string | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * FIXES_UI §12 / SET-11 — one in-app confirmation dialog for row delete,
 * restore, permanent delete and column delete.
 *
 * A native `window.confirm` cannot show a red destructive button, cannot show
 * a busy state while the server decides, and keeps its own modal behaviour
 * that the user cannot cancel with Esc. This dialog keeps Cancel as the safe
 * default, closes on Esc and on a backdrop click, ignores duplicate submits
 * while busy, and leaves the failure message visible instead of closing.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  hint,
  destructive = false,
  busy = false,
  canConfirm = true,
  requireText,
  requireTextLabel = 'Type DELETE to confirm',
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');

  useEffect(() => {
    if (open) {
      setSubmitting(false);
      // Every opening starts the typed gate from scratch so a previous
      // attempt can never leave the confirm button pre-enabled.
      setTypedConfirmation('');
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const typedGateSatisfied = !requireText || typedConfirmation.trim() === requireText;
  const blocked = busy || submitting || !canConfirm || !typedGateSatisfied;
  const submit = () => {
    if (blocked) {
      return;
    }
    setSubmitting(true);
    try {
      const result = onConfirm();
      if (result && typeof (result as Promise<void>).then === 'function') {
        // Disabled while in flight so a double click cannot submit twice; a
        // failure keeps the dialog (and its message) on screen.
        void Promise.resolve(result).finally(() => setSubmitting(false));
        return;
      }
    } catch {
      // The parent keeps the dialog open and shows the failure.
    }
    setSubmitting(false);
  };

  return (
    <div
      className="confirm-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !blocked) {
          onCancel();
        }
      }}
    >
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !blocked) {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 className="confirm-dialog__title">{title}</h2>
        {children ? <div className="confirm-dialog__body">{children}</div> : null}
        {hint ? <p className="confirm-dialog__hint">{hint}</p> : null}
        {requireText ? (
          <>
            <p className="confirm-dialog__hint">
              Type <strong>{requireText}</strong> to confirm.
            </p>
            <input
              className="confirm-dialog__input"
              aria-label={requireTextLabel}
              autoFocus
              value={typedConfirmation}
              onChange={(event) => setTypedConfirmation(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !blocked) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </>
        ) : null}
        {error ? (
          <p className="confirm-dialog__error" role="alert">{error}</p>
        ) : null}
        <div className="confirm-dialog__actions">
          <button
            className="button button--secondary"
            type="button"
            disabled={blocked}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            className={`button ${destructive ? 'button--danger' : 'button--primary'}`}
            type="button"
            disabled={blocked}
            onClick={submit}
          >
            {busy || submitting ? 'Working…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export default ConfirmDialog;
