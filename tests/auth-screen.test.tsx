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

/**
 * Password visibility toggle (eye): flips the field between password/text,
 * updates its label and icon, works with mouse AND keyboard, and never
 * interferes with autofill or the sign-in submit flow.
 */
describe('password visibility toggle', () => {
  it('starts hidden: type=password with a labelled Show password button', () => {
    render(<AuthScreen />);

    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    // Autofill contract must survive the wrapper.
    expect(input).toHaveAttribute('id', 'dks-password');
    expect(input).toHaveAttribute('name', 'password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('click toggles visibility and flips the label back and forth', () => {
    render(<AuthScreen />);

    const input = screen.getByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });

    fireEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('is keyboard operable (Enter and Space), keeping the typed value intact', async () => {
    const user = await import('@testing-library/user-event').then((module) => module.default.setup());
    render(<AuthScreen />);

    const input = screen.getByLabelText('Password');
    fireEvent.change(input, { target: { value: 's3cret!' } });

    const toggle = screen.getByRole('button', { name: 'Show password' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue('s3cret!');

    await user.keyboard(' ');
    expect(input).toHaveAttribute('type', 'password');
  });

  it('is type=button so clicking it never submits the sign-in form', () => {
    const onSignIn = vi.fn();
    render(<AuthScreen onSignIn={onSignIn} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('sign-in still submits the typed password while visibility is toggled on', async () => {
    const onSignIn = vi.fn().mockResolvedValue(undefined);
    render(<AuthScreen onSignIn={onSignIn} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'office@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onSignIn).toHaveBeenCalledWith('office@example.com', 'secret'));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
  });
});
