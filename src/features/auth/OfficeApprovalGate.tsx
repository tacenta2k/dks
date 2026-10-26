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
 *
 * Visual contract: one centered card on the standard auth backdrop, all
 * colours from the theme tokens so the screen is readable in BOTH light and
 * dark mode. The technical detail of a failure is secondary, readable text —
 * never white-on-white, never dominant.
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

interface GateStateCopy {
  ariaRole: 'status' | 'alert';
  ariaLabel: string;
  title: string;
  body: string;
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

  let copy: GateStateCopy;
  if (approval === 'checking') {
    copy = {
      ariaRole: 'status',
      ariaLabel: 'Checking sign-in approval',
      title: 'Opening your session…',
      body: 'Checking whether this sign-in is approved. Please wait.',
    };
  } else if (approval === 'pending') {
    copy = {
      ariaRole: 'status',
      ariaLabel: 'Waiting for admin approval',
      title: 'Waiting for admin approval',
      body: 'Your sign-in is pending approval from the administrator. This page updates automatically once the request is decided. You cannot open the sheet or customer data until then.',
    };
  } else if (approval === 'denied') {
    copy = {
      ariaRole: 'alert',
      ariaLabel: 'Sign-in denied',
      title: 'Sign-in request denied',
      body: 'Your request to sign in from this session was denied by the administrator.',
    };
  } else if (approval === 'revoked') {
    copy = {
      ariaRole: 'alert',
      ariaLabel: 'Approval revoked',
      title: 'Session approval revoked',
      body: 'Your access was revoked by the administrator. Sign out, or sign in again to request approval.',
    };
  } else {
    copy = {
      ariaRole: 'alert',
      ariaLabel: 'Approval status unavailable',
      title: 'Cannot verify sign-in approval',
      body: 'The approval status of this session could not be verified. Check your connection and try again.',
    };
  }

  return (
    <div className="office-approval-gate" role={copy.ariaRole} aria-label={copy.ariaLabel}>
      <section className="office-approval-card">
        <h1 className="office-approval-card__title">{copy.title}</h1>
        <p className="office-approval-card__body">{copy.body}</p>

        {approval === 'pending' ? (
          <p className="office-approval-card__meta" role="note">
            Request submitted {requestedAt}. This applies only to this device session.
          </p>
        ) : null}
        {approval === 'denied' ? (
          <p className="office-approval-card__meta" role="note">
            You can submit a new request by signing in again, or ask the administrator.
          </p>
        ) : null}

        {error?.message ? (
          approval === 'error' ? (
            <>
              {/* The technical cause is secondary: readable, quiet, wrapped. */}
              <p className="office-approval-card__detail" role="note">
                {error.message}
              </p>
              <div className="office-approval-card__actions">
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
            </>
          ) : (
            <>
              <p className="office-approval-card__detail" role="alert">
                {error.message}
              </p>
              <div className="office-approval-card__actions">
                <button type="button" className="button button--secondary" onClick={onSignOut}>
                  Sign out
                </button>
              </div>
            </>
          )
        ) : (
          <div className="office-approval-card__actions">
            {approval === 'error' ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => void appStore.getState().refreshSessionApproval()}
              >
                Retry
              </button>
            ) : null}
            <button type="button" className="button button--secondary" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
