import { Component, Suspense, lazy, type ErrorInfo, type ReactNode } from 'react';

import { defaultErrorReporter } from '../../features/diagnostics/error-reporting';

/**
 * Route-level code splitting (PERFORMANCE_AUDIT.md H1).
 *
 * Every screen is imported dynamically, so the startup path (splash, sign-in,
 * session restore, shell chrome) never downloads or parses AG Grid, Recharts,
 * XLSX or jsPDF. The chunks are only requested when the screen is first shown,
 * and each one is a real ES module import — not a manualChunks grouping — so
 * nothing is fetched or evaluated until the view actually renders.
 */
export const DashboardView = lazy(() =>
  import('../../features/dashboard/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);

export const SheetView = lazy(() =>
  import('../../features/sheet/SheetPage').then((module) => ({ default: module.SheetPage })),
);

export const SettingsView = lazy(() =>
  import('../../features/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);

/**
 * The admin surfaces (Tools menu, Recycle Bin, Audit Log) share one module and
 * therefore one chunk; the spreadsheet and PDF libraries they need are loaded
 * later still, at the Import/Export/Print action itself.
 */
export const AdminSheetActionsView = lazy(() =>
  import('../../features/admin/AdminTools').then((module) => ({ default: module.AdminSheetActions })),
);

export const AdminRecycleBinView = lazy(() =>
  import('../../features/admin/AdminTools').then((module) => ({ default: module.AdminRecycleBinPanel })),
);

export const AdminAuditLogView = lazy(() =>
  import('../../features/admin/AdminTools').then((module) => ({ default: module.AdminAuditLogPanel })),
);

export interface ViewLoadingFallbackProps {
  /** Screen name, so the status is specific ("Opening the Visa sheet"). */
  label: string;
}

/**
 * Compact in-content placeholder shown while a screen chunk is in flight.
 * Flat grey bars at the final layout's real sizes — no shimmer, no spinner, no
 * full-screen takeover — and a polite live region so assistive tech announces
 * the wait without stealing focus.
 */
export function ViewLoadingFallback({ label }: ViewLoadingFallbackProps): ReactNode {
  return (
    <div className="view-loading" role="status" aria-live="polite" aria-busy="true">
      <p className="view-loading__caption">Opening {label}…</p>
      <div className="view-loading__bars" aria-hidden="true">
        <span className="view-loading__bar view-loading__bar--toolbar" />
        <span className="view-loading__bar" />
        <span className="view-loading__bar" />
        <span className="view-loading__bar view-loading__bar--short" />
      </div>
    </div>
  );
}

interface ViewErrorBoundaryProps {
  children: ReactNode;
  /** Screen name, shown in the recovery card. */
  label: string;
}

interface ViewErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches a failed dynamic import (missing/corrupt chunk on disk) and keeps the
 * shell — navigation, sync status, notifications — alive around a readable
 * error instead of leaving an empty content area.
 *
 * `window.location.reload()` is deliberately the only retry: React.lazy caches
 * a rejected import promise, so re-rendering the same lazy component would
 * throw the cached error again. A fresh document is what re-requests the file.
 */
export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  public state: ViewErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ViewErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(_error: Error, _info: ErrorInfo): void {
    void defaultErrorReporter.report({
      category: 'renderer',
      severity: 'error',
      code: 'RENDERER_VIEW_LOAD_ERROR',
      component: 'renderer/lazy-view',
      process: 'renderer',
    });
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  public render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <section className="view-load-error" role="alert" aria-labelledby="dks-view-load-error-title">
        <h2 id="dks-view-load-error-title" className="view-load-error__title">
          {this.props.label} did not open
        </h2>
        <p className="view-load-error__body">
          Part of DKS could not be read from this PC. Your saved records are unaffected — reload to try
          again, or pick another screen from the navigation.
        </p>
        <button type="button" className="button button--primary" onClick={this.handleReload}>
          Reload DKS
        </button>
      </section>
    );
  }
}

export interface LazyViewProps {
  /** Screen name for the loading status and the failure card. */
  label: string;
  /** Boundary identity: changing it clears a previous failure on navigation. */
  boundaryKey: string;
  children: ReactNode;
}

/**
 * One Suspense + boundary pair for the content area. `boundaryKey` lets a view
 * that failed stay contained: switching screens clears the error and mounts the
 * newly selected screen instead of pinning the failure to the shell.
 */
export function LazyView({ label, boundaryKey, children }: LazyViewProps): ReactNode {
  return (
    <ViewErrorBoundary key={boundaryKey} label={label}>
      <Suspense fallback={<ViewLoadingFallback label={label} />}>{children}</Suspense>
    </ViewErrorBoundary>
  );
}
