import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { StatusColors, StatusThresholds } from '../../lib/domain';
import type { SheetRepository } from '../sheet/repository';
import { createInMemorySheetRepository } from '../sheet/repository';
import {
  DASHBOARD_CARD_DEFINITIONS,
  getDashboardSummary,
  type DashboardFilterId,
  type DashboardSummary,
} from './selectors';
import './dashboard.css';

export interface DashboardPageProps {
  repository?: SheetRepository;
  today?: string | Date;
  thresholds?: StatusThresholds;
  colors?: Partial<StatusColors> | Record<string, string>;
  onFilter?: (filter: DashboardFilterId) => void;
  /**
   * Optional host sync action run before the dashboard reloads its local
   * repository. The full app supplies its existing Supabase sync here; without
   * it, Refresh honestly reloads the current local data source only.
   */
  onRefresh?: () => Promise<void>;
  /** Bumped after local mutations / successful syncs; the page re-fetches in
   *  place so remounts cannot steal focus from user inputs. */
  refreshToken?: number;
}

interface DashboardRefreshFeedback {
  kind: 'success' | 'error';
  message: string;
}

function emptySummary(): DashboardSummary {
  return getDashboardSummary([], [], {});
}

function cardTestId(id: DashboardFilterId): string {
  const testIds: Record<DashboardFilterId, string> = {
    all: 'total',
    expiresToday: 'today',
    expiresIn1Day: '1-day',
    expiringThisWeek: 'week',
    expiringThisMonth: 'month',
    within3Months: '3-months',
    within6Months: '6-months',
    within1Year: '1-year',
    expired: 'expired',
  };
  return `dashboard-card-${testIds[id]}`;
}

export function DashboardPage({
  repository: providedRepository,
  today,
  thresholds,
  colors,
  onFilter,
  onRefresh,
  refreshToken = 0,
}: DashboardPageProps) {
  const repository = useMemo(
    () => providedRepository ?? createInMemorySheetRepository(),
    [providedRepository],
  );
  const [summary, setSummary] = useState<DashboardSummary>(emptySummary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFeedback, setRefreshFeedback] = useState<DashboardRefreshFeedback | null>(null);
  const manualRefreshInFlight = useRef(false);

  const loadSummary = useCallback(async (options?: { quiet?: boolean }): Promise<boolean> => {
    if (!options?.quiet) {
      setLoading(true);
    }
    try {
      const [columns, rows] = await Promise.all([repository.getColumns(), repository.getRows()]);
      setSummary(getDashboardSummary(rows, columns, { today, thresholds, colors }));
      setError(null);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the dashboard.');
      return false;
    } finally {
      if (!options?.quiet) {
        setLoading(false);
      }
    }
  }, [colors, repository, thresholds, today]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const lastRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (lastRefreshToken.current === refreshToken) {
      return;
    }
    lastRefreshToken.current = refreshToken;
    void loadSummary({ quiet: true });
  }, [refreshToken, loadSummary]);

  const handleRefresh = useCallback(async () => {
    // A ref guard closes the tiny window before React re-renders the button
    // as disabled, so an enthusiastic double-click can never overlap syncs.
    if (manualRefreshInFlight.current) {
      return;
    }
    manualRefreshInFlight.current = true;
    setRefreshing(true);
    setRefreshFeedback(null);

    let syncError: string | null = null;
    if (onRefresh) {
      try {
        await onRefresh();
      } catch (caught) {
        syncError = caught instanceof Error ? caught.message : 'Sync did not complete.';
      }
    }

    // Always reload from the local repository afterwards. A failed sync must
    // not discard the device's current data or unsaved outbox work.
    const loaded = await loadSummary({ quiet: true });
    if (loaded) {
      setRefreshFeedback(
        syncError
          ? {
            kind: 'error',
            message: `Sync did not complete (${syncError}). Showing the latest local data.`,
          }
          : {
            kind: 'success',
            message: onRefresh ? 'Sync complete. Dashboard refreshed.' : 'Dashboard refreshed.',
          },
      );
    }
    manualRefreshInFlight.current = false;
    setRefreshing(false);
  }, [loadSummary, onRefresh]);

  if (loading) {
    return <div className="dashboard-page dashboard-page--loading" aria-live="polite">Loading dashboard…</div>;
  }

  return (
    <div className="dashboard-page">
      {error ? <div className="dashboard-alert" role="alert">{error}</div> : null}

      <div className="dashboard-summary-header">
        <span className="dashboard-summary-header__label">Expiry summary</span>
        <button
          className="button button--secondary dashboard-refresh-button"
          type="button"
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={() => void handleRefresh()}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {refreshFeedback ? (
        <p
          className={`dashboard-refresh-status dashboard-refresh-status--${refreshFeedback.kind}`}
          role={refreshFeedback.kind === 'error' ? 'alert' : 'status'}
        >
          {refreshFeedback.message}
        </p>
      ) : null}

      <section className="dashboard-cards" aria-label="Expiry summary">
        {summary.cards.map((card) => (
          <button
            className={`dashboard-card dashboard-card--${card.id}`}
            data-testid={cardTestId(card.id)}
            type="button"
            key={card.id}
            aria-label={`${card.label}: ${card.count}`}
            onClick={() => onFilter?.(card.id)}
          >
            <span className="dashboard-card__label">{card.label}</span>
            <strong className="dashboard-card__value">{card.count}</strong>
          </button>
        ))}
      </section>

      <section className="dashboard-chart-grid" aria-label="Dashboard charts">
        <article className="dashboard-panel">
          <div className="dashboard-panel__heading">
            <div>
              <p className="dashboard-eyebrow">Status</p>
              <h2>Expiry status</h2>
            </div>
            <span className="dashboard-panel__meta">Active entries</span>
          </div>
          <div className="dashboard-chart dashboard-chart--pie" role="img" aria-label="Status breakdown">
            <PieChart width={280} height={230}>
              <Pie
                data={summary.statusPie}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={85}
                paddingAngle={2}
                stroke="none"
              >
                {summary.statusPie.map((entry) => <Cell fill={entry.color} key={entry.name} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </div>
          <ul className="dashboard-legend" aria-label="Status counts">
            {summary.statusPie.map((entry) => (
              <li key={entry.name}>
                <span className="dashboard-legend__name">
                  <span className="dashboard-legend__swatch" style={{ backgroundColor: entry.color }} aria-hidden="true" />
                  {entry.name}
                </span>
                <strong>{entry.value}</strong>
              </li>
            ))}
          </ul>
        </article>

        <article className="dashboard-panel dashboard-panel--wide">
          <div className="dashboard-panel__heading">
            <div>
              <p className="dashboard-eyebrow">Forecast</p>
              <h2>Next 12 months</h2>
            </div>
            <span className="dashboard-panel__meta">Upcoming expiries</span>
          </div>
          <div className="dashboard-chart dashboard-chart--bar" role="img" aria-label="Expiries over the next 12 months">
            <BarChart width={640} height={270} data={summary.nextTwelveMonths} margin={{ top: 10, right: 10, left: -18, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="month" tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }} interval={0} angle={-35} textAnchor="end" height={55} />
              <YAxis allowDecimals={false} tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="count" name="Expiries" fill="var(--color-primary)" radius={[5, 5, 0, 0]} />
            </BarChart>
          </div>
        </article>
      </section>
    </div>
  );
}

export { DASHBOARD_CARD_DEFINITIONS };
export * from './selectors';
export default DashboardPage;
