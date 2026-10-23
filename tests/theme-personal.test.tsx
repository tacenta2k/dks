import type { Session } from '@supabase/supabase-js';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthClientLike } from '../src/features/auth/auth-service';
import { App } from '../src/renderer/App';
import { hasSavedThemePreference, THEME_STORAGE_KEY } from '../src/lib/theme';
import { sheetGridThemeClass } from '../src/features/sheet/grid-behaviour';

const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: 2_000_000_000,
  token_type: 'bearer',
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2025-01-01T00:00:00.000Z',
  },
} as Session;

function makeClient() {
  const client: AuthClientLike = {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ data: { session, user: session.user }, error: null }),
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: 'user-1', email: 'admin@example.com', role: 'admin' },
            error: null,
          }),
        })),
      })),
    })),
  };
  return client;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('personal theme wins over the workspace default (R2-08)', () => {
  it('detects an existing personal theme preference', () => {
    expect(hasSavedThemePreference()).toBe(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(hasSavedThemePreference()).toBe(true);
  });

  it('does not re-theme the session when the workspace default is saved in Settings', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const service = new AuthService(makeClient());
    render(<App authService={service} />);

    await screen.findByRole('banner', { name: 'DKS top bar' });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    const themeSelect = await screen.findByLabelText('Theme default');
    // Saving the workspace "default theme for new sign-ins" must not touch the
    // active personal theme.
    fireEvent.change(themeSelect, { target: { value: 'light' } });

    await waitFor(() => expect(themeSelect).toHaveValue('light'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  }, 20_000);

  it('keeps the personal toggle authoritative after opening Settings', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const service = new AuthService(makeClient());
    render(<App authService={service} />);

    await screen.findByRole('banner', { name: 'DKS top bar' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    await screen.findByLabelText('Theme default');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    // Leaving Settings and coming back does not reset it.
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace' }));
    await screen.findByLabelText('Theme default');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  }, 20_000);

  it('switches the AG Grid theme class with the app theme (R2-07)', () => {
    expect(sheetGridThemeClass('light')).toBe('ag-theme-quartz');
    expect(sheetGridThemeClass('dark')).toBe('ag-theme-quartz ag-theme-quartz-dark');
  });
});
