import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SettingsPage,
  type DksSettings,
} from '../src/features/settings/SettingsPage';
import {
  currencySymbolCodePoints,
  currencySymbolDirection,
} from '../src/features/settings/currency-symbol';
import {
  settingsRecordToPartialSettings,
  settingsToRows,
} from '../src/features/settings/settings-service';
import { createSqliteStore } from '../electron/main/sqlite';

/**
 * Settings → Workspace, currency symbol.
 *
 * The Omani Rial symbol is stored as a logical string and must stay that way.
 * The display bug was a direction problem: inside the LTR Settings form the
 * trailing full stop was resolved in the paragraph direction and moved to the
 * wrong end, so the symbol read reversed. The field now carries its own
 * direction, resolved from its own value, and the stored characters are never
 * touched.
 */

/** U+0631 U+002E U+0639 U+002E — ر.ع. */
const OMANI_RIAL = '\u0631\u002E\u0639\u002E';
const OMANI_RIAL_CODE_POINTS = ['U+0631', 'U+002E', 'U+0639', 'U+002E'];

/** Bidi controls and HTML that must never be persisted. */
const FORBIDDEN_IN_VALUE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C\u00AD]|<[a-z/][^>]*>/i;

const nav = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));

function openWorkspace() {
  nav('Workspace');
  return screen.getByLabelText('Currency symbol') as HTMLInputElement;
}

function renderAdmin(settings?: Partial<DksSettings>) {
  const onSettingsChange = vi.fn();
  render(
    <SettingsPage
      role="admin"
      settings={settings}
      onSettingsChange={onSettingsChange}
    />,
  );
  return onSettingsChange;
}

/** The app's own persistence shape: rows → JSON → settings again. */
function reloadThroughStorage(settings: DksSettings) {
  const rows = settingsToRows(settings);
  const stored = JSON.parse(JSON.stringify(
    Object.fromEntries(rows.map((row) => [row.key, row.value])),
  )) as Record<string, unknown>;
  return settingsRecordToPartialSettings(stored);
}

describe('currency symbol — default value', () => {
  it('is exactly ر.ع. with the expected code points', () => {
    expect(DEFAULT_SETTINGS.currency.symbol).toBe(OMANI_RIAL);
    expect(currencySymbolCodePoints(DEFAULT_SETTINGS.currency.symbol)).toEqual(
      OMANI_RIAL_CODE_POINTS,
    );
    expect(DEFAULT_SETTINGS.currency.symbol).toHaveLength(4);
    // No bidi controls, no invisible marks, no markup in the default.
    expect(DEFAULT_SETTINGS.currency.symbol).not.toMatch(FORBIDDEN_IN_VALUE);
  });

  it('the same logical value reaches the input unchanged', () => {
    renderAdmin();
    const input = openWorkspace();
    expect(input).toHaveValue(OMANI_RIAL);
    expect(currencySymbolCodePoints(input.value)).toEqual(OMANI_RIAL_CODE_POINTS);
  });
});

describe('currency symbol — direction', () => {
  it('resolves RTL for the Arabic symbol so the punctuation keeps its place', () => {
    // The logical string is R . A . — under LTR the trailing stop is resolved
    // in the paragraph direction and lands at the wrong end (rendered "ع.ر.");
    // under RTL the whole four characters form one RTL run and read correctly.
    expect(currencySymbolDirection(OMANI_RIAL)).toBe('rtl');
    expect(currencySymbolDirection('\u0639')).toBe('rtl'); // isolated ain
    expect(currencySymbolDirection('\u05D0')).toBe('rtl'); // Hebrew alef (bidi R)
  });

  it('renders the symbol field RTL and leaves every other control LTR', () => {
    renderAdmin();
    const symbol = openWorkspace();
    expect(symbol).toHaveAttribute('dir', 'rtl');

    // Scoped to this field only: the rest of the Workspace section is LTR.
    for (const label of ['Currency code', 'Currency decimals', 'Theme default', 'Primary expiry column']) {
      const control = screen.getByLabelText(label);
      expect(control).not.toHaveAttribute('dir', 'rtl');
    }
    expect(document.querySelector('.settings-field-grid')?.getAttribute('dir')).toBeNull();
    expect(document.querySelector('.settings-section')?.getAttribute('dir')).toBeNull();
    expect(document.documentElement.dataset.dir).toBeUndefined();
  });

  it('never reorders the stored characters to fake the display', () => {
    renderAdmin();
    const input = openWorkspace();
    // The rendered value is the logical string, not a pre-reversed one.
    expect(input.value).toBe(OMANI_RIAL);
    expect([...input.value]).toEqual([...OMANI_RIAL]);
  });
});

describe('currency symbol — Latin symbols keep working', () => {
  it.each([
    ['$', 'ltr'],
    ['OMR', 'ltr'],
    ['USD', 'ltr'],
    ['€', 'ltr'],
    ['', 'ltr'],
    ['ر.ع. USD', 'rtl'],
    ['USD ر.ع.', 'ltr'],
    // Digits and marks are not strong characters: they never flip the field,
    // and neither does a bidi control character somebody typed by accident.
    ['١٢٣', 'ltr'],
    ['\u200F', 'ltr'],
    ['\u064Bر', 'rtl'],
  ])('%s resolves %s', (value, expected) => {
    expect(currencySymbolDirection(value)).toBe(expected);
  });

  it.each(['$', 'OMR', 'USD', '€'])('edits and persists %s unchanged', async (symbol) => {
    const onSettingsChange = renderAdmin();
    const input = openWorkspace();

    fireEvent.change(input, { target: { value: symbol } });

    expect(input).toHaveValue(symbol);
    // $ and € are not strong characters: they inherit the form's LTR.
    expect(input).toHaveAttribute('dir', 'ltr');
    await waitFor(() => expect(onSettingsChange).toHaveBeenCalled());
    const saved = onSettingsChange.mock.calls.at(-1)?.[0] as DksSettings;
    expect(saved.currency.symbol).toBe(symbol);
    expect(reloadThroughStorage(saved).currency).toMatchObject({ symbol, code: 'OMR' });
  });
});

describe('currency symbol — save and reload', () => {
  it('persists the logical string and reloads it unchanged', async () => {
    const onSettingsChange = renderAdmin();
    const input = openWorkspace();

    // React's change event only fires when the value actually changes, so the
    // edit goes through a different value first — as a user would.
    fireEvent.change(input, { target: { value: '$' } });
    fireEvent.change(input, { target: { value: OMANI_RIAL } });
    await waitFor(() => expect(onSettingsChange).toHaveBeenCalled());

    const saved = onSettingsChange.mock.calls.at(-1)?.[0] as DksSettings;
    expect(currencySymbolCodePoints(saved.currency.symbol)).toEqual(OMANI_RIAL_CODE_POINTS);
    expect(saved.currency.symbol).not.toMatch(FORBIDDEN_IN_VALUE);

    // Through the same row/JSON shape SQLite and Supabase store.
    const restored = reloadThroughStorage(saved);
    expect(currencySymbolCodePoints(String(restored.currency?.symbol))).toEqual(
      OMANI_RIAL_CODE_POINTS,
    );

    // Reopening Settings renders that stored value, still RTL, still logical.
    renderAdmin(restored as Partial<DksSettings>);
    const reopened = screen.getAllByLabelText('Currency symbol').at(-1) as HTMLInputElement;
    expect(reopened).toHaveValue(OMANI_RIAL);
    expect(currencySymbolCodePoints(reopened.value)).toEqual(OMANI_RIAL_CODE_POINTS);
    expect(reopened).toHaveAttribute('dir', 'rtl');
  });

  it('leaves the value untouched when the same symbol is typed again', async () => {
    const onSettingsChange = renderAdmin();
    const input = openWorkspace();

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: OMANI_RIAL } });

    await waitFor(() => expect(onSettingsChange).toHaveBeenCalled());
    const saved = onSettingsChange.mock.calls.at(-1)?.[0] as DksSettings;
    expect(saved.currency.symbol).toBe(OMANI_RIAL);
    expect(saved.currency.symbol).toHaveLength(4);
  });

  it('survives a real SQLite round trip (local settings + outbox)', () => {
    const store = createSqliteStore({ filename: ':memory:' });
    try {
      store.setSettings({ currency: { code: 'OMR', symbol: OMANI_RIAL, decimals: 3 } });

      const stored = store.getSettings().currency as { symbol?: string } | undefined;
      expect(currencySymbolCodePoints(String(stored?.symbol))).toEqual(OMANI_RIAL_CODE_POINTS);

      // The outbox payload is what sync sends to Supabase: same characters.
      const queued = store.listOutbox('pending') as Array<{ payload?: unknown }>;
      const currencyItem = queued.find((item) => (
        (item.payload as { key?: string } | undefined)?.key === 'currency'
      ));
      const payloadSymbol = (currencyItem?.payload as { value?: { symbol?: string } } | undefined)
        ?.value?.symbol;
      expect(currencySymbolCodePoints(String(payloadSymbol))).toEqual(OMANI_RIAL_CODE_POINTS);
    } finally {
      store.close();
    }
  });

  it('does not add anything to the value while the direction is applied', () => {
    renderAdmin();
    const input = openWorkspace();
    // Direction is an attribute on the element, never a character in the value.
    expect(input.getAttribute('dir')).toBe('rtl');
    expect(Array.from(input.value).map((character) => character.codePointAt(0))).toEqual([
      0x0631, 0x002e, 0x0639, 0x002e,
    ]);
  });
});

describe('currency symbol — themes unchanged', () => {
  it('renders the same control in light and AMOLED (dark) themes', () => {
    const lightRender = render(<SettingsPage role="admin" />);
    const lightInput = openWorkspace();
    const lightMarkup = lightInput.outerHTML;
    const lightSection = lightInput.closest('.settings-section')?.className;
    lightRender.unmount();

    document.documentElement.dataset.theme = 'dark';
    try {
      const darkRender = render(<SettingsPage role="admin" />);
      const darkInput = openWorkspace();
      expect(darkInput.outerHTML).toBe(lightMarkup);
      expect(darkInput.closest('.settings-section')?.className).toBe(lightSection);
      expect(darkInput).toHaveValue(OMANI_RIAL);
      expect(currencySymbolCodePoints(darkInput.value)).toEqual(OMANI_RIAL_CODE_POINTS);
      expect(darkInput).toHaveAttribute('dir', 'rtl');
      darkRender.unmount();
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });

  it('adds no theme-specific styling for the field', () => {
    const css = readFileSync(resolve(__dirname, '..', 'src/features/settings/settings.css'), 'utf8');
    // The fix is a bidi attribute, so neither theme needs a new rule and the
    // field keeps painting from theme tokens (see dark-theme-parity).
    expect(css).not.toMatch(/currency/i);
    expect(css).not.toMatch(/\[dir=['"]?rtl/i);
    expect(css).not.toMatch(/\[dir\s*=|unicode-bidi/i);
  });
});
