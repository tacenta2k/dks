/**
 * H1 failure behaviour: a screen chunk that cannot be read must leave the shell
 * usable and explain itself inside the content area — never a blank page and
 * never the sign-in form, which would look like a logout.
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { LazyView, ViewLoadingFallback } from '../src/renderer/components/LazyView';

function ExplodingChunk(): never {
  throw new Error('Failed to fetch dynamically imported module: ./SheetPage-abc.js');
}

describe('lazy view boundary', () => {
  it('renders the loading fallback as a compact polite status', () => {
    render(<ViewLoadingFallback label="Visa sheet" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Opening Visa sheet…');
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('contains a failed chunk to the content area with a reload action', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <LazyView label="Visa sheet" boundaryKey="sheet">
          <ExplodingChunk />
        </LazyView>,
      );
    } finally {
      consoleError.mockRestore();
    }

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Visa sheet did not open');
    expect(alert).toHaveTextContent(/saved records are unaffected/i);
    expect(screen.getByRole('button', { name: 'Reload DKS' })).toBeInTheDocument();
  });

  it('clears the failure when navigation changes the boundary key', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <LazyView label="Visa sheet" boundaryKey="sheet">
        <ExplodingChunk />
      </LazyView>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Visa sheet did not open');
    consoleError.mockRestore();

    rerender(
      <LazyView label="Dashboard" boundaryKey="dashboard">
        <p>Charts are here</p>
      </LazyView>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Charts are here')).toBeInTheDocument();
  });
});
