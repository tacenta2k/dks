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

interface ChartBoxSize {
  width: number;
  height: number;
}

const CHART_TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-surface-raised)',
  borderColor: 'var(--color-border-strong)',
  borderRadius: '8px',
  color: 'var(--color-text)',
  fontSize: '12.5px',
  boxShadow: '0 8px 20px var(--color-shadow)',
};

const CHART_TOOLTIP_ITEM_STYLE = {
  color: 'var(--color-text)',
};

const CHART_TOOLTIP_LABEL_STYLE = {
  color: 'var(--color-text-muted)',
  fontWeight: 600,
};

const EMPTY_RING_DATA = [{ name: 'No expiry data yet', value: 1 }];

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

/**
 * Measures a chart host box via callback ref + ResizeObserver so Recharts SVGs
 * fill wide/tall desktop panels and respond to sidebar/window changes, while
 * falling back cleanly to deterministic dimensions in zero-layout environments
 * such as jsdom.
 */
function useMeasuredChartSize(fallbackWidth: number, fallbackHeight: number) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<ChartBoxSize>({
    width: fallbackWidth,
    height: fallbackHeight,
  });

  useEffect(() => {
    if (!node) {
      return;
    }

    const applyMeasured = (rawWidth: number, rawHeight: number) => {
      const nextWidth = Math.floor(rawWidth);
      const nextHeight = Math.floor(rawHeight);
      if (nextWidth <= 0 || nextHeight <= 0) {
        return;
      }
      setSize((prev) => (
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight }
      ));
    };

    const rect = node.getBoundingClientRect();
    applyMeasured(rect.width || node.clientWidth, rect.height || node.clientHeight);

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      applyMeasured(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return { containerRef: setNode, size };
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

  const pieChart = useMeasuredChartSize(240, 240);
  const barChart = useMeasuredChartSize(780, 320);

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

  const nonZeroStatusCount = summary.statusPie.filter((entry) => entry.value > 0).length;
  const hasStatusData = nonZeroStatusCount > 0;
  const pieDiameter = Math.max(176, Math.min(pieChart.size.width, pieChart.size.height, 440));
  const outerRadius = Math.floor(pieDiameter * 0.43);
  const innerRadius = Math.round(outerRadius * 0.62);

  const barWidth = Math.max(280, barChart.size.width);
  const barHeight = Math.max(220, barChart.size.height);
  const compactMonths = barWidth < 740;
  const axisFontSize = barWidth >= 860 ? 12 : 11;

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
        {summary.cards.map((card) => {
          const isUrgentCard = card.id === 'expired' || card.id === 'expiresToday';
          return (
            <button
              className={`dashboard-card dashboard-card--${card.id}`}
              data-testid={cardTestId(card.id)}
              data-alert={isUrgentCard && card.count > 0 ? 'active' : undefined}
              type="button"
              key={card.id}
              aria-label={`${card.label}: ${card.count}`}
              onClick={() => onFilter?.(card.id)}
            >
              <span className="dashboard-card__label">{card.label}</span>
              <strong className="dashboard-card__value">{card.count}</strong>
            </button>
          );
        })}
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
          <div className="dashboard-status-body">
            <div
              className="dashboard-chart dashboard-chart--pie"
              ref={pieChart.containerRef}
              role="img"
              aria-label="Status breakdown"
            >
              <div className="dashboard-chart__canvas">
                {hasStatusData ? (
                  <PieChart width={pieDiameter} height={pieDiameter}>
                    <Pie
                      data={summary.statusPie}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={innerRadius}
                      outerRadius={outerRadius}
                      paddingAngle={nonZeroStatusCount > 1 ? 2 : 0}
                      stroke="var(--color-surface)"
                      strokeWidth={2}
                      isAnimationActive={false}
                    >
                      {summary.statusPie.map((entry) => <Cell fill={entry.color} key={entry.name} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={CHART_TOOLTIP_STYLE}
                      itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                      labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                    />
                  </PieChart>
                ) : (
                  <div className="dashboard-chart__empty-ring">
                    <PieChart width={pieDiameter} height={pieDiameter}>
                      <Pie
                        data={EMPTY_RING_DATA}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={innerRadius}
                        outerRadius={outerRadius}
                        fill="var(--color-surface-muted)"
                        stroke="var(--color-border-strong)"
                        strokeWidth={1}
                        isAnimationActive={false}
                      />
                    </PieChart>
                    <span className="dashboard-chart__empty-label">No expiry data yet</span>
                  </div>
                )}
              </div>
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
          </div>
        </article>

        <article className="dashboard-panel dashboard-panel--wide">
          <div className="dashboard-panel__heading">
            <div>
              <p className="dashboard-eyebrow">Forecast</p>
              <h2>Next 12 months</h2>
            </div>
            <span className="dashboard-panel__meta">Upcoming expiries</span>
          </div>
          <div
            className="dashboard-chart dashboard-chart--bar"
            ref={barChart.containerRef}
            role="img"
            aria-label="Expiries over the next 12 months"
          >
            <div className="dashboard-chart__canvas">
              <BarChart
                width={barWidth}
                height={barHeight}
                data={summary.nextTwelveMonths}
                margin={{ top: 12, right: 12, left: 0, bottom: compactMonths ? 6 : 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                <XAxis
                  dataKey="month"
                  tick={{ fill: 'var(--color-text-muted)', fontSize: axisFontSize }}
                  interval={0}
                  angle={compactMonths ? -30 : 0}
                  textAnchor={compactMonths ? 'end' : 'middle'}
                  tickMargin={compactMonths ? 4 : 8}
                  height={compactMonths ? 46 : 32}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  width={38}
                  domain={[0, (dataMax: number) => Math.max(4, dataMax)]}
                  tick={{ fill: 'var(--color-text-muted)', fontSize: axisFontSize }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: 'var(--color-surface-muted)' }}
                  contentStyle={CHART_TOOLTIP_STYLE}
                  itemStyle={CHART_TOOLTIP_ITEM_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                />
                <Bar
                  dataKey="count"
                  name="Expiries"
                  fill="var(--color-primary)"
                  maxBarSize={52}
                  radius={[5, 5, 0, 0]}
                  isAnimationActive={false}
                />
              </BarChart>
            </div>
          </div>
        </article>
      </section>
    </div>
  );
}

export { DASHBOARD_CARD_DEFINITIONS };
export * from './selectors';
export default DashboardPage;
