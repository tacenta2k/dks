import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../src/features/ui/ConfirmDialog';

/**
 * SET-11 / FIXES_UI §12 — confirmation dialogs: destructive actions use a red
 * button, Cancel is the safe default, Esc closes, duplicate submits are
 * blocked while the action runs, and a failure stays visible.
 */
describe('confirmation dialog (SET-11)', () => {
  const base = {
    open: true,
    title: 'Permanently delete this record?',
    confirmLabel: 'Delete permanently',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders a destructive confirmation with Cancel as the safe default', () => {
    render(
      <ConfirmDialog {...base} destructive>
        <p>Ada Lovelace is removed for good.</p>
      </ConfirmDialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Permanently delete this record?' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace is removed for good.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toHaveClass('button--danger');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('button--secondary');
  });

  it('closes on Escape and on Cancel without confirming', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} onCancel={onCancel} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(base.onConfirm).not.toHaveBeenCalled();
  });

  it('prevents duplicate submits while the action is in flight', async () => {
    let resolve: () => void = () => undefined;
    const onConfirm = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    render(<ConfirmDialog {...base} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Delete permanently' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    resolve();
    await waitFor(() => expect(confirm).toBeEnabled());
  });

  it('keeps the failure message visible and stays open', () => {
    render(
      <ConfirmDialog
        {...base}
        error="Only administrators may permanently delete records."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Only administrators/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('blocks confirm until the typed requirement is met', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        {...base}
        canConfirm={false}
        hint={<>Type DELETE to confirm.</>}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    expect(screen.getByText(/Type DELETE to confirm/)).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    render(<ConfirmDialog {...base} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
