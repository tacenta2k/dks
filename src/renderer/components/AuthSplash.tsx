import dksLogo from '../../assets/dks-logo.png';
import dksLogoDark from '../../assets/dks-logo-dark.png';

/**
 * Neutral startup splash — shown while the persisted session is being restored.
 *
 * The login form must NEVER be the first paint of a signed-in app: restoring a
 * Supabase session takes 1–3 seconds (token refresh over the network), and the
 * store starts at `unauthenticated`, so rendering <AuthScreen /> during that
 * window showed the email/password form and then swapped it for the workspace.
 *
 * This screen is deliberately inert: it has no inputs, no focusable controls
 * and no sign-in affordances, so a keystroke during restoration can never land
 * in a form that is about to disappear. It is announced politely, so screen
 * readers do not mistake it for the sign-in page.
 */
export function AuthSplash() {
  return (
    <main className="login-page auth-splash" aria-labelledby="auth-splash-title">
      <section className="login-card auth-splash__card" data-auth-status="restoring" aria-busy="true">
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
        <h1 id="auth-splash-title" className="auth-splash__title">DKS</h1>
        <p className="auth-splash__status" role="status" aria-live="polite">
          <span className="auth-splash__spinner" aria-hidden="true" />
          <span>Restoring your session…</span>
        </p>
      </section>
    </main>
  );
}
