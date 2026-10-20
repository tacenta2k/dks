import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { ColumnWizard } from '../src/features/sheet/column-wizard';

describe('column wizard', () => {
  it('creates a date expiry column and exposes passport configuration', () => {
    const onSubmit = vi.fn();

    render(<ColumnWizard existingColumns={[]} onClose={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Passport expiry' } });
    fireEvent.change(screen.getByLabelText('Column type'), { target: { value: 'date_expiry' } });
    fireEvent.click(screen.getByLabelText('Passport number column'));
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Passport expiry',
      type: 'date_expiry',
      isPassport: true,
    }));
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
});
