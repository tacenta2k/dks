import { useState } from 'react';

import { can } from '../../lib/permissions';
import type { Profile, SupabaseHealth } from '../../features/auth/auth-types';
import type { AppView, ResolvedTheme, ThemePreference } from '../../lib/types';

export interface AppShellProps {
  activeView?: AppView;
  onNavigate?: (view: AppView) => void;
  themePreference?: ThemePreference;
  resolvedTheme?: ResolvedTheme;
  onThemeChange?: (preference: ThemePreference) => void;
  profile?: Profile | null;
  userEmail?: string | null;
  health?: SupabaseHealth;
  isDemoMode?: boolean;
  onLogout?: () => void | Promise<void>;
}

const themeLabels: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const viewCopy: Record<AppView, { eyebrow: string; title: string; description: string }> = {
  dashboard: {
    eyebrow: 'Overview',
    title: 'Dashboard',
    description: 'Your workspace is ready for the next step.',
  },
  sheet: {
    eyebrow: 'Workspace',
    title: 'Visa sheet',
    description: 'Your visa records will appear here in STEP 4.',
  },
};

function Brand() {
  return (
    <div className="brand-lockup">
      <div className="brand-mark" aria-hidden="true">
        <span>D</span>
      </div>
      <div>
        <p className="brand-name">DKS</p>
        <p className="brand-caption">Office workspace</p>
      </div>
    </div>
  );
}

function DashboardPlaceholder() {
  return (
    <div className="placeholder-panel placeholder-panel--dashboard">
      <div className="placeholder-panel__icon" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div>
        <h2>Good things are on the way</h2>
        <p>
          The dashboard will bring your expiry overview, alerts, and next actions together here.
        </p>
      </div>
    </div>
  );
}

function SheetPlaceholder() {
  return (
    <div className="placeholder-panel placeholder-panel--sheet">
      <div className="sheet-preview" aria-hidden="true">
        <span className="sheet-preview__line sheet-preview__line--header" />
        <span className="sheet-preview__line" />
        <span className="sheet-preview__line" />
        <span className="sheet-preview__line" />
      </div>
      <div>
        <h2>A clear view of every record</h2>
        <p>
          The editable visa sheet, expiry dates, and validation tools will be added in the next steps.
        </p>
      </div>
    </div>
  );
}

export function AppShell({
  activeView = 'dashboard',
  onNavigate = () => undefined,
  themePreference = 'system',
  resolvedTheme = 'light',
  onThemeChange = () => undefined,
  profile = null,
  userEmail = null,
  health = {
    configured: false,
    reachable: 'unknown',
    authenticated: false,
    error: null,
  },
  isDemoMode = false,
  onLogout = () => undefined,
}: AppShellProps) {
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const copy = viewCopy[activeView];
  const role = profile?.role;
  const displayEmail = userEmail ?? profile?.email ?? (isDemoMode ? 'demo@dks.local' : null);
  const healthLabel = isDemoMode
    ? 'Offline demo'
    : health.reachable === 'reachable'
      ? 'Supabase healthy'
      : health.reachable === 'unreachable'
        ? 'Supabase unavailable'
        : health.configured
          ? 'Supabase checking'
          : 'Supabase not configured';

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Sidebar">
        <Brand />
        <nav className="sidebar__nav" aria-label="Primary navigation">
          <p className="sidebar__label">Workspace</p>
           <button
            className={`nav-item${activeView === 'dashboard' ? ' nav-item--active' : ''}`}
            type="button"
            aria-current={activeView === 'dashboard' ? 'page' : 'false'}
            aria-label="Open Dashboard"
            onClick={() => onNavigate('dashboard')}
          >
            <span className="nav-item__icon nav-item__icon--grid" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <span>Dashboard</span>
          </button>
          <button
            className={`nav-item${activeView === 'sheet' ? ' nav-item--active' : ''}`}
            type="button"
            aria-current={activeView === 'sheet' ? 'page' : 'false'}
            aria-label="Open Sheet"
            onClick={() => onNavigate('sheet')}
          >
            <span className="nav-item__icon nav-item__icon--sheet" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Visa sheet</span>
           </button>
          {can(role, 'adminNavigation') ? (
            <button
              className="nav-item"
              type="button"
              aria-label="Open Admin tools"
              onClick={() => undefined}
            >
              <span className="nav-item__icon nav-item__icon--grid" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span>Admin tools</span>
            </button>
          ) : null}
        </nav>
        <div className="sidebar__bottom">
          <div className="sync-status">
            <span className="sync-status__dot" aria-hidden="true" />
            <div>
              <p className="sync-status__title">Workspace health</p>
              <p className="sync-status__detail">{healthLabel}</p>
            </div>
          </div>
          <p className="sidebar__version">STEP 2 · Role-gated workspace</p>
        </div>
      </aside>

      <div className="app-shell__body">
        <header className="top-bar" role="banner" aria-label="DKS top bar">
          <div className="top-bar__heading">
            <p className="breadcrumb">DKS <span aria-hidden="true">/</span> {copy.eyebrow}</p>
            <p className="top-bar__context">A focused space for your team&apos;s records</p>
          </div>
          <div className="top-bar__actions">
            <div className="theme-control">
              <button
                className="theme-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={isThemeMenuOpen}
                aria-label={`Theme: ${themePreference}`}
                onClick={() => setIsThemeMenuOpen((isOpen) => !isOpen)}
              >
                <span className="theme-button__swatch" data-theme-icon={resolvedTheme} aria-hidden="true" />
                <span>Theme: {themeLabels[themePreference]}</span>
                <span className="theme-button__chevron" aria-hidden="true">⌄</span>
              </button>
              {isThemeMenuOpen ? (
                <div className="theme-menu" role="menu" aria-label="Theme preference">
                  {(Object.keys(themeLabels) as ThemePreference[]).map((preference) => (
                    <button
                      className="theme-menu__item"
                      type="button"
                      role="menuitemradio"
                      aria-checked={themePreference === preference}
                      key={preference}
                      onClick={() => {
                        onThemeChange(preference);
                        setIsThemeMenuOpen(false);
                      }}
                    >
                      <span>{themeLabels[preference]}</span>
                      {themePreference === preference ? <span aria-hidden="true">✓</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {displayEmail ? (
              <div style={{ display: 'grid', gap: 2, justifyItems: 'end' }}>
                <span style={{ color: 'var(--color-text)', fontSize: 12, fontWeight: 700 }}>
                  {displayEmail}
                </span>
                {profile ? (
                  <span
                    aria-label={`Role: ${profile.role}`}
                    style={{ color: 'var(--color-text-muted)', fontSize: 10, fontWeight: 700 }}
                  >
                    {profile.role === 'admin' ? 'Admin' : 'Office'}
                  </span>
                ) : null}
              </div>
            ) : null}
            <button className="button" type="button" onClick={onLogout}>
              Log out
            </button>
            <div className="avatar" aria-label={displayEmail ? `Signed in as ${displayEmail}` : 'DKS preview user'}>
              {(displayEmail?.[0] ?? 'D').toUpperCase()}
            </div>
          </div>
        </header>

        <main className="content" aria-labelledby="page-title">
          <div className="content__intro">
            <div>
              <p className="eyebrow">{copy.eyebrow}</p>
              <h1 id="page-title">{copy.title}</h1>
              <p className="content__description">{copy.description}</p>
            </div>
            <div className="content__badge">
              <span className="content__badge-dot" aria-hidden="true" />
              <span>Offline-first</span>
            </div>
            {can(role, 'export') ? (
              <button className="button" type="button" aria-label="Export data" onClick={() => undefined}>
                Export data
              </button>
            ) : null}
          </div>

          {activeView === 'dashboard' ? <DashboardPlaceholder /> : <SheetPlaceholder />}
        </main>
      </div>
    </div>
  );
}
