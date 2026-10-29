/**
 * v0.1.8 (Issue B) — sign-in / restore timing instrumentation.
 *
 * Emits ONE console line per finished flow, prefixed `[dks:timing]`, which the
 * Electron main process forwards to main.log (electron/main/index.ts,
 * forwardRendererDiagnostics). Privacy contract — enforced by
 * tests/signin-timing.test.ts:
 *   - only flow/phase NAMES, millisecond numbers, role ('admin'|'office'),
 *     an outcome word and an error CODE are ever written;
 *   - never an email, password, token, user/session/request id, URL, or any
 *     customer data. `extra` values are restricted to an allow-list of keys.
 */

export type TimingFlow = 'signin' | 'restore' | 'office-approval' | 'office-open' | 'workspace-open';

const ALLOWED_EXTRA_KEYS = new Set(['role', 'outcome', 'code', 'attempts', 'warm', 'kind']);
const SAFE_VALUE = /^[A-Za-z0-9_.:-]{0,40}$/;

export interface TimingSpan {
  readonly flow: TimingFlow;
  /** Record the duration since the previous mark (or start) under `phase`. */
  mark: (phase: string) => void;
  /** Emit the line once; later calls are ignored. Returns the phase map. */
  end: (extra?: Record<string, string | number | boolean | null | undefined>) => Record<string, number>;
}

type Sink = (line: string) => void;

let sink: Sink = (line) => {
  try {
    // console.info is what the main process forwards (console-message).
    console.info(line);
  } catch {
    // Diagnostics must never break sign-in.
  }
};

/** Test hook: capture emitted lines. Returns a restore function. */
export function setTimingSink(next: Sink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

const active = new Map<TimingFlow, TimingSpan>();

function nowMs(): number {
  try {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  } catch {
    return Date.now();
  }
}

function safePhase(phase: string): string {
  return phase.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'phase';
}

export function startTimingSpan(flow: TimingFlow): TimingSpan {
  const startedAt = nowMs();
  let last = startedAt;
  let ended = false;
  const phases: Record<string, number> = {};

  const span: TimingSpan = {
    flow,
    mark: (phase) => {
      if (ended) return;
      const at = nowMs();
      const key = safePhase(phase);
      phases[key] = (phases[key] ?? 0) + Math.max(0, Math.round(at - last));
      last = at;
    },
    end: (extra) => {
      if (ended) return phases;
      ended = true;
      if (active.get(flow) === span) active.delete(flow);
      const total = Math.max(0, Math.round(nowMs() - startedAt));
      const parts = [`[dks:timing] ${flow}`];
      for (const [key, value] of Object.entries(phases)) parts.push(`${key}=${value}ms`);
      parts.push(`total=${total}ms`);
      for (const [key, value] of Object.entries(extra ?? {})) {
        if (!ALLOWED_EXTRA_KEYS.has(key) || value === undefined || value === null) continue;
        const text = String(value);
        if (SAFE_VALUE.test(text)) parts.push(`${key}=${text}`);
      }
      sink(parts.join(' '));
      return { ...phases, total };
    },
  };
  active.set(flow, span);
  return span;
}

/** The in-flight span for `flow`, so lower layers can add phase marks. */
export function activeTimingSpan(flow: TimingFlow): TimingSpan | undefined {
  return active.get(flow);
}
