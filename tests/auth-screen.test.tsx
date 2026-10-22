import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';

import { AuthScreen } from '../src/features/auth/AuthScreen';

/**
 * R2-03 — sign-in clicks were ignored while the Supabase health check was
 * running, because the shared auth status "loading" disabled the inputs and
 * the Sign in button. Only an in-flight sign-in request may disable anything.
 */
describe('sign-in form during the Supabase health check', () => {
  it('keeps the email and password inputs enabled while auth status is loading', () => {
    render(
      <AuthScreen
        authStatus="loading"
        health={{ configured: true, reachable: 'unknown', authenticated: false, error: null }}
      />,
    );

    expect(screen.getByLabelText('Email')).toBeEnabled();
    expect(screen.getByLabelText('Password')).toBeEnabled();
    expect(screen.getByText('Checking Supabase connection.')).toBeInTheDocument();
  });

  it('submits with enabled inputs while the health check is still running', async () => {
    const onSignIn = vi.fn().mockResolvedValue(undefined);
    render(
      <AuthScreen
        authStatus="loading"
        onSignIn={onSignIn}
        health={{ configured: true, reachable: 'unknown', authenticated: false, error: null }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'office@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onSignIn).toHaveBeenCalledWith('office@example.com', 'secret'));
  });

  it('disables only the Sign in button while a sign-in request is in flight', async () => {
    let resolveSignIn: (() => void) | undefined;
    const onSignIn = vi.fn(() => new Promise<void>((resolve) => {
      resolveSignIn = resolve;
    }));

    render(
      <AuthScreen
        authStatus="loading"
        onSignIn={onSignIn}
        health={{ configured: true, reachable: 'reachable', authenticated: false, error: null }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'office@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled());
    expect(screen.getByLabelText('Email')).toBeEnabled();
    expect(screen.getByLabelText('Password')).toBeEnabled();

    resolveSignIn?.();
    await waitFor(() => expect(screen.getByRole('button', { name: /^sign in/i })).toBeEnabled());
  });

  it('does not recreate the inputs when the health result arrives', () => {
    const { rerender } = render(
      <AuthScreen
        authStatus="loading"
        health={{ configured: true, reachable: 'unknown', authenticated: false, error: null }}
      />,
    );

    const email = screen.getByLabelText('Email');
    rerender(
      <AuthScreen
        authStatus="unauthenticated"
        health={{ configured: true, reachable: 'reachable', authenticated: false, error: null }}
      />,
    );

    // Same DOM node → no remount, so typing/focus is never stolen.
    expect(screen.getByLabelText('Email')).toBe(email);
    expect(screen.getByText('Supabase is reachable.')).toBeInTheDocument();
  });
});
