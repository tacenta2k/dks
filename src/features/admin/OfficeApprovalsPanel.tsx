import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createOfficeApprovalService,
  type OfficeApprovalService,
  type OfficeSigninRequest,
} from '../auth/office-approval-service';

/**
 * Admin popover for Office sign-in approvals.
 *
 *   - Badge counts PENDING requests (the shared Office account is awaiting a
 *     decision); the message never identifies an individual staff member —
 *     this is a shared account.
 *   - Pending rows offer Approve / Deny; the approved list offers Revoke.
 *   - Every action goes through the server-side RPCs; the panel simply shows
 *     whatever the server answers (never asserts success without the
 *     round-trip row).
 */
export interface OfficeApprovalsPanelProps {
  service?: OfficeApprovalService | null;
  /** Poll interval for the badge (default 10 s). */
  pollMs?: number;
}

const REQUEST_REFRESH_MS = 10_000;

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? value : when.toLocaleString();
}

function PeopleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function OfficeApprovalsPanel({ service: providedService, pollMs }: OfficeApprovalsPanelProps) {
  const [service] = useState<OfficeApprovalService | null>(() => providedService ?? createOfficeApprovalService());
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<OfficeSigninRequest[]>([]);
  const [approved, setApproved] = useState<OfficeSigninRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    if (!service) {
      setError('Supabase is not configured — approvals cannot be read here.');
      return;
    }
    const result = await service.listRequests(['pending', 'approved']);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    const rows = result.data ?? [];
    setPending(rows.filter((row) => row.status === 'pending'));
    setApproved(rows.filter((row) => row.status === 'approved'));
    setError(null);
  }, [service]);

  // Light poll keeps the badge meaningful even while the popover is closed;
  // every action forces a refresh so the panel reflects the server truth.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), pollMs ?? REQUEST_REFRESH_MS);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh, pollMs]);

  // Escape / outside click closes (matches NotificationBell).
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (sectionRef.current && target && !sectionRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const decide = async (request: OfficeSigninRequest, decision: 'approved' | 'denied'): Promise<void> => {
    if (!service) {
      return;
    }
    setBusyId(request.id);
    setError(null);
    const result = await service.decideRequest(request.id, decision);
    if (result.error) {
      setError(result.error.message);
    }
    setBusyId(null);
    await refresh();
  };

  const revoke = async (request: OfficeSigninRequest): Promise<void> => {
    if (!service) {
      return;
    }
    setBusyId(request.id);
    setError(null);
    const result = await service.revokeRequest(request.id);
    if (result.error) {
      setError(result.error.message);
    }
    setBusyId(null);
    await refresh();
  };

  const badgeCount = pending.length;

  return (
    <section className="office-approvals" aria-label="Office sign-in approvals" ref={sectionRef}>
      <button
        className="office-approvals__button notification-bell__button"
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={badgeCount > 0 ? `Office sign-in approvals (${badgeCount} pending)` : 'Office sign-in approvals'}
        title="Office sign-in approvals"
        onClick={() => setOpen((current) => !current)}
      >
        <PeopleIcon />
        {badgeCount > 0 ? (
          <span className="notification-bell__badge" aria-label={`${badgeCount} pending`}>
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="office-approvals__panel notification-bell__panel" role="dialog" aria-label="Office sign-in approvals">
          <header className="notification-bell__header">
            <strong>Office sign-ins</strong>
            <span className="notification-bell__count">
              {badgeCount} pending · {approved.length} approved
            </span>
          </header>

          {error ? <p className="sheet-form__error" role="alert">{error}</p> : null}

          {pending.length === 0 && approved.length === 0 ? (
            <p className="notification-bell__empty">No Office sign-in requests</p>
          ) : null}

          {pending.length > 0 ? (
            <>
              <p className="office-approvals__section-title" role="heading" aria-level={3}>Pending requests</p>
              <ul className="notification-bell__list">
                {pending.map((request) => (
                  <li className="notification-bell__item" key={request.id}>
                    <div className="notification-bell__body">
                      <strong>Office account</strong>
                      <p className="notification-bell__meta">
                        Requested {formatDateTime(request.requestedAt)}
                      </p>
                    </div>
                    <div className="office-approvals__actions">
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={busyId === request.id}
                        onClick={() => void decide(request, 'approved')}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="button button--danger"
                        disabled={busyId === request.id}
                        onClick={() => void decide(request, 'denied')}
                      >
                        Deny
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {approved.length > 0 ? (
            <>
              <p className="office-approvals__section-title" role="heading" aria-level={3}>Approved sessions</p>
              <ul className="notification-bell__list">
                {approved.map((request) => (
                  <li className="notification-bell__item" key={request.id}>
                    <div className="notification-bell__body">
                      <strong>Office account</strong>
                      <p className="notification-bell__meta">
                        Approved {formatDateTime(request.decidedAt ?? request.requestedAt)}
                      </p>
                    </div>
                    <div className="office-approvals__actions">
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={busyId === request.id}
                        onClick={() => void revoke(request)}
                      >
                        Revoke
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
