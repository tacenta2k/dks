import { FormEvent, useState } from 'react';

import { isSupabaseConfigured } from '../../lib/supabase';
import type { AuthStatus, SupabaseHealth } from './auth-types';

export interface AuthScreenProps {
  onSignIn?: (email: string, password: string) => Promise<void> | void;
  authStatus?: AuthStatus;
  authError?: string | null;
  health?: SupabaseHealth;
  demoAvailable?: boolean;
  onDemoContinue?: () => void;
}

export function AuthScreen({
  onSignIn = async () => undefined,
  authStatus = 'unauthenticated',
  authError = null,
  health = {
    configured: false,
    reachable: 'unknown',
    authenticated: false,
    error: null,
  },
  demoAvailable = false,
  onDemoContinue,
}: AuthScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const isSubmitting = authStatus === 'loading';
  const safeDemoAvailable =
    demoAvailable && !isSupabaseConfigured() && (import.meta.env.DEV || import.meta.env.MODE === 'test');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setValidationError('Enter your email and password.');
      return;
    }

    setValidationError(null);
    await onSignIn(normalizedEmail, password);
  };

  const errorMessage = validationError ?? authError;
  const healthMessage = !health.configured
    ? 'Supabase configuration is not present.'
    : health.reachable === 'reachable'
      ? 'Supabase is reachable.'
      : health.reachable === 'unreachable'
        ? 'Supabase is unavailable. Try again.'
        : 'Checking Supabase connection.';

  return (
    <main className="login-page" aria-labelledby="login-title">
      <section className="login-card">
        <div className="brand-mark brand-mark--large" aria-hidden="true">
          <span>D</span>
        </div>
        <p className="eyebrow">DKS workspace</p>
        <h1 id="login-title">Sign in to DKS</h1>
        <p className="login-card__description">
          Keep visa and medical records organized in one calm, focused workspace.
        </p>

        <div className="placeholder-callout" role="status" aria-label="Supabase health">
          <span className="placeholder-callout__dot" aria-hidden="true" />
          <span>{healthMessage}</span>
        </div>

        {errorMessage ? (
          <div className="placeholder-callout" role="alert">
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <div style={{ display: 'grid', gap: 8, marginBottom: 14, textAlign: 'left' }}>
            <label htmlFor="dks-email">Email</label>
            <input
              id="dks-email"
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isSubmitting}
              required
            />
          </div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 17, textAlign: 'left' }}>
            <label htmlFor="dks-password">Password</label>
            <input
              id="dks-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSubmitting}
              required
            />
          </div>
          <button className="button button--primary button--wide" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
            <span aria-hidden="true">→</span>
          </button>
        </form>

        {safeDemoAvailable && onDemoContinue ? (
          <>
            <div className="placeholder-callout" role="note">
              <span className="placeholder-callout__dot" aria-hidden="true" />
              <span>Authentication will be connected in STEP 2 for configured workspaces.</span>
            </div>
            <button className="button button--wide" type="button" onClick={onDemoContinue}>
              Continue to workspace (offline demo)
              <span aria-hidden="true">→</span>
            </button>
            <p className="login-card__footnote">
              Demo mode is available only because no Supabase configuration is present.
            </p>
          </>
        ) : (
          <p className="login-card__footnote">Use your DKS account to continue.</p>
        )}
      </section>
      <footer className="login-page__footer">DKS · Designed for dependable office workflows</footer>
    </main>
  );
}
