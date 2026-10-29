import dksLogo from '../../assets/dks-logo.png';
import dksLogoDark from '../../assets/dks-logo-dark.png';

/**
 * v0.1.7 — neutral start-up splash shown while the persisted session is being
 * restored. It deliberately contains NO form, input or sign-in copy: an
 * already signed-in user must never see the email/password screen flash
 * before the dashboard. The AuthScreen is rendered only once restoration has
 * finished and there is no session.
 */
export function StartupSplash() {
  return (
    <main
      className="startup-splash"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading DKS"
      data-testid="startup-splash"
    >
      <div className="startup-splash__inner">
        <div className="brand-logo brand-logo--splash">
          <img
            className="brand-logo__img brand-logo__img--on-light"
            src={dksLogo}
            alt="DKS"
            width={168}
            height={75}
            draggable={false}
          />
          <img
            className="brand-logo__img brand-logo__img--on-dark"
            src={dksLogoDark}
            alt=""
            aria-hidden="true"
            width={168}
            height={75}
            draggable={false}
          />
        </div>
        <span className="startup-splash__spinner" aria-hidden="true" />
      </div>
    </main>
  );
}
