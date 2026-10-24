import { useEffect } from 'react';

import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';

import type { AppStore } from '../../lib/store';

/**
 * The ONLY surface a pending / denied / revoked Office session may see.
 *
 * This component deliberately renders no workspace data, no Sheet, no
 * Dashboard, no local cache — just the request status and a sign-out option.
 * Success is NEVER displayed: a transition to 'approved' removes this gate by
 * letting App render the workspace, so "success" can only ever be the real
 * app, after server confirmation.
 */
export interface OfficeApprovalGateProps {
  appStore: StoreApi<AppStore>;
  onSignOut: () => void;
}

const POLL_INTERVAL_MS = 5_000;

function formatRequestedAt(value: string | undefined): string {
  if (!value) {
    return 'just now';
  }
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? value : when.toLocaleString();
}

export function OfficeApprovalGate({ appStore, onSignOut }: OfficeApprovalGateProps) {
  const approval = useStore(appStore, (state) => state.sessionApproval);
  const request = useStore(appStore, (state) => state.sessionApprovalRequest);
  const error = useStore(appStore, (state) => state.sessionApprovalError);

  useEffect(() => {
    if (approval !== 'pending' && approval !== 'checking') {
      return undefined;
    }
    // The client polls its own row; decisions always arrive server-side.
    const tick = () => {
      void appStore.getState().refreshSessionApproval();
    };
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', tick);
    };
  }, [appStore, approval]);

  const requestedAt = formatRequestedAt(request?.requestedAt);

  if (approval === 'checking') {
    return (
      <div className="auth-screen office-approval-gate" role="status" aria-label="Waiting for admin approval">
        <section className="auth-card office-approval-card">
          <h1>Opening your session…</h1>
          <p role="status">Checking whether this sign-in is approved. Please wait.</p>
        </section>
      </div>
    );
  }

  if (approval === 'pending') {
    return (
      <div className="auth-screen office-approval-gate" role="status" aria-label="Waiting for admin approval">
        <section className="auth-card office-approval-card">
          <h1>Waiting for admin approval</h1>
          <p>
            Your sign-in is pending approval from the administrator. This page updates automatically
            once the request is decided. You cannot open the sheet or customer data until then.
          </p>
          <p className="office-approval-card__meta" role="note">
            Request submitted {requestedAt}. This applies only to this device session.
          </p>
          {error ? <p className="sheet-form__error" role="alert">{error.message}</p> : null}
          <button type="button" className="button button--secondary" onClick={onSignOut}>
            Sign out
          </button>
        </section>
      </div>
    );
  }

  if (approval === 'denied') {
    return (
      <div className="auth-screen office-approval-gate" role="alert" aria-label="Sign-in denied">
        <section className="auth-card office-approval-card">
          <h1>Sign-in request denied</h1>
          <p>Your request to sign in from this session was denied by the administrator.</p>
          <p className="office-approval-card__meta" role="note">
            You can submit a new request by signing in again, or ask the administrator.
          </p>
          <button type="button" className="button button--secondary" onClick={onSignOut}>
            Sign out
          </button>
        </section>
      </div>
    );
  }

  if (approval === 'revoked') {
    return (
      <div className="auth-screen office-approval-gate" role="alert" aria-label="Approval revoked">
        <section className="auth-card office-approval-card">
          <h1>Session approval revoked</h1>
          <p>Your access was revoked by the administrator. Sign out, or sign in again to request approval.</p>
          <button type="button" className="button button--secondary" onClick={onSignOut}>
            Sign out
          </button>
        </section>
      </div>
    );
  }

  // 'error' state: fail CLOSED; never fall through to the workspace.
  return (
    <div className="auth-screen office-approval-gate" role="alert" aria-label="Approval status unavailable">
      <section className="auth-card office-approval-card">
        <h1>Cannot verify sign-in approval</h1>
        <p>{error?.message ?? 'The approval status of this session could not be verified.'}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void appStore.getState().refreshSessionApproval()}
          >
            Retry
          </button>
          <button type="button" className="button button--secondary" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
