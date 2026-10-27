import type { DksLocalApi } from './types';

/**
 * The one value the renderer is allowed to report to the main process:
 *
 *   'office-pending' — an Office session awaits administrator approval. Every
 *                      customer-data channel (`dks:local:get-snapshot`,
 *                      `get-settings`, …) is refused in the main process.
 *   'allowed'        — Admin, demo, or an Office session the server confirmed.
 *
 * This is DEFENSE IN DEPTH on top of Supabase RLS. The main process is the
 * enforcement point, so a renderer that dispatches a customer-data IPC call
 * before the main process has stored the matching clearance value is refused.
 */
export type SessionClearance = 'office-pending' | 'allowed';

export interface SessionClearanceBridge {
  /**
   * The value the main process LAST ACKNOWLEDGED. `null` means "no write has
   * been acknowledged yet" — which is exactly the state a workspace effect must
   * treat as "not safe to dispatch a customer-data IPC call".
   */
  acknowledged: () => SessionClearance | null;
  /**
   * Write a clearance value and resolve once the main process has stored it.
   * Writes are serialised in call order, so a caller that awaits `whenApplied`
   * can never race a later write into the window between "renderer dispatched"
   * and "main process stored".
   */
  write: (value: SessionClearance) => Promise<void>;
  /** Resolves once the newest write has been acknowledged. Never rejects. */
  whenApplied: () => Promise<void>;
}

/**
 * Wrap the `dks:local:set-session-clearance` push channel so the workspace
 * effects can tell "the main process holds this clearance" apart from "the
 * renderer merely intends to write it".
 *
 * The previous implementation fired `local.setSessionClearance(...)` and
 * dropped the promise. The workspace mounted in the same React commit, so its
 * first `dks:local:get-snapshot` could be dispatched before the main process
 * had flipped `office-pending` → `allowed` — producing exactly the
 * `Waiting for admin approval — this session cannot access local records.`
 * error on a session the administrator had already approved.
 */
export function createSessionClearanceBridge(
  local?: Pick<DksLocalApi, 'setSessionClearance'> | null,
): SessionClearanceBridge {
  let acknowledged: SessionClearance | null = null;
  let chain: Promise<void> = Promise.resolve();

  const write = (value: SessionClearance): Promise<void> => {
    chain = chain.then(async () => {
      const setter = local?.setSessionClearance;
      if (typeof setter !== 'function') {
        // No bridge (offline/demo/renderer without the preload): there is no
        // main process to fence, so the value is satisfied locally.
        acknowledged = value;
        return;
      }
      try {
        await setter(value);
        acknowledged = value;
      } catch {
        // A refused/missing bridge must NOT be treated as "allowed". Leave the
        // last acknowledged value untouched so the workspace effects keep
        // seeing the state the main process actually holds.
        return;
      }
    });
    return chain;
  };

  return {
    acknowledged: () => acknowledged,
    write,
    whenApplied: () => chain,
  };
}

/**
 * Await the newest acknowledged clearance write and report whether the main
 * process currently holds a clearance that permits customer-data IPC calls.
 *
 * Called by the workspace effects before their FIRST `getSnapshot` /
 * `getSettings` dispatch, so "approval → workspace" never depends on the
 * relative scheduling of two fire-and-forget IPC calls in one React commit.
 */
export async function clearanceAllowsWorkspace(
  bridge: SessionClearanceBridge | null,
): Promise<boolean> {
  if (!bridge) {
    return true;
  }
  await bridge.whenApplied();
  return bridge.acknowledged() === 'allowed';
}
