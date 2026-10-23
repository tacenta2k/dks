import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { ColumnWizard } from '../src/features/sheet/column-wizard';

describe('column wizard', () => {
  it('creates a date expiry column without any passport configuration (F1)', () => {
    const onSubmit = vi.fn();

    render(<ColumnWizard existingColumns={[]} onClose={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Passport expiry' } });
    fireEvent.change(screen.getByLabelText('Column type'), { target: { value: 'date_expiry' } });
    // The "Passport number column" checkbox must no longer exist: passport
    // values are plain text and carry no country-specific format rule.
    expect(screen.queryByLabelText(/passport number column/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Passport expiry',
      type: 'date_expiry',
    }));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('isPassport');
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('is_passport');
  });

  it('requires dropdown options before adding a dropdown column', () => {
    const onSubmit = vi.fn();

    render(<ColumnWizard existingColumns={[]} onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Visa type' } });
    fireEvent.change(screen.getByLabelText('Column type'), { target: { value: 'dropdown' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/at least one dropdown option/i);
  });

  it('refuses to create a user column named like the generated "Days Left" column', () => {
    const onSubmit = vi.fn();

    render(<ColumnWizard existingColumns={[]} onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Days Left' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/generated system column/i);

    // Spacing/casing variants are blocked exactly the same way…
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: ' days_left ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/generated system column/i);

    // …while a legitimately different name still goes through.
    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Total days left' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Total days left' }));
  });
});
