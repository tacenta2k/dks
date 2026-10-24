import { FormEvent, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { isSupabaseConfigured } from '../../lib/supabase';
import type { AuthStatus, SupabaseHealth } from './auth-types';
import dksLogo from '../../assets/dks-logo.png';
import dksLogoDark from '../../assets/dks-logo-dark.png';

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
  // Password visibility toggle: the input keeps id/name/autoComplete so
  // autofill and password managers behave exactly as before; only `type`
  // flips between "password" and "text".
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  // R2-03: ONLY an in-flight sign-in disables the form.  The Supabase health
  // check also flips the shared auth status to "loading"; reusing that status
  // here disabled the inputs (and swallowed the first click) while the health
  // probe was still running.
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const isSubmitting = submitting;
  const safeDemoAvailable =
    demoAvailable && !isSupabaseConfigured() && (import.meta.env.DEV || import.meta.env.MODE === 'test');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) {
      return;
    }
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setValidationError('Enter your email and password.');
      return;
    }

    setValidationError(null);
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSignIn(normalizedEmail, password);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
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
      <section className="login-card" data-auth-status={authStatus}>
        {/* The official DKS logo (full lockup from build/logo-source.png —
            never the cropped mark). The dark variant is the same artwork
            lightened, so no white plate shows behind it in dark mode. */}
        <div className="brand-logo brand-logo--sign-in">
          <img
            className="brand-logo__img brand-logo__img--on-light"
            src={dksLogo}
            alt="DKS — Software for businesses"
            width={196}
            height={87}
            draggable={false}
          />
          <img
            className="brand-logo__img brand-logo__img--on-dark"
            src={dksLogoDark}
            alt=""
            aria-hidden="true"
            width={196}
            height={87}
            draggable={false}
          />
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
              required
            />
          </div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 17, textAlign: 'left' }}>
            <label htmlFor="dks-password">Password</label>
            <div className="password-field">
              <input
                id="dks-password"
                name="password"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button
                type="button"
                className="password-field__toggle"
                aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                title={passwordVisible ? 'Hide password' : 'Show password'}
                aria-pressed={passwordVisible}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? (
                  <EyeOff size={17} aria-hidden="true" />
                ) : (
                  <Eye size={17} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
          <button
            className="button button--primary button--wide"
            type="submit"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
            <span aria-hidden="true">→</span>
          </button>
        </form>

        {safeDemoAvailable && onDemoContinue ? (
          <>
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
