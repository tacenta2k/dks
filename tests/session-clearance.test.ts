import { describe, expect, it, vi } from 'vitest';

import {
  clearanceAllowsWorkspace,
  createSessionClearanceBridge,
  type SessionClearance,
} from '../src/lib/session-clearance';

interface FakeClearanceLocal {
  calls: Array<SessionClearance>;
  /** When set, every write blocks until the test resolves this gate. */
  gate: Promise<void> | null;
  gateResolver: (() => void) | null;
  setSessionClearance: (state: SessionClearance) => Promise<SessionClearance>;
}

function makeFakeLocal(options: { gate?: boolean } = {}): FakeClearanceLocal {
  const local: FakeClearanceLocal = {
    calls: [],
    gate: null,
    gateResolver: null,
    setSessionClearance: async (state: SessionClearance) => {
      local.calls.push(state);
      if (local.gate) {
        await local.gate;
      }
      return state;
    },
  };

  if (options.gate) {
    local.gate = new Promise<void>((resolve) => {
      local.gateResolver = resolve;
    });
  }

  return local;
}

describe('session clearance bridge', () => {
  it('reports null until the main process has acknowledged a write', async () => {
    const local = makeFakeLocal();
    const bridge = createSessionClearanceBridge(local);

    expect(bridge.acknowledged()).toBeNull();
    const pending = bridge.write('allowed');
    expect(bridge.acknowledged()).toBeNull();
    await pending;
    expect(bridge.acknowledged()).toBe('allowed');
  });

  it('serialises writes so a later value can never land before an earlier one', async () => {
    const local = makeFakeLocal({ gate: true });
    const bridge = createSessionClearanceBridge(local);

    const first = bridge.write('office-pending');
    const second = bridge.write('allowed');

    // Let the serialised chain start. The first write has been called and is
    // blocked on the gate; the second has NOT started yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(local.calls).toEqual(['office-pending']);
    expect(bridge.acknowledged()).toBeNull();

    local.gateResolver?.();
    await Promise.all([first, second]);

    expect(local.calls).toEqual(['office-pending', 'allowed']);
    expect(bridge.acknowledged()).toBe('allowed');
  });

  it('does not treat a refused write as allowed', async () => {
    const local = makeFakeLocal();
    local.setSessionClearance = async () => {
      local.calls.push('allowed');
      throw new Error('ipc channel closed');
    };
    const bridge = createSessionClearanceBridge(local);

    await bridge.write('allowed');

    // The main process never stored anything, so the value stays
    // unacknowledged and the workspace effects must refuse to dispatch
    // customer-data IPC.
    expect(bridge.acknowledged()).toBeNull();
    expect(await clearanceAllowsWorkspace(bridge)).toBe(false);
  });

  it('keeps the last acknowledged value when a later write is refused', async () => {
    const local = makeFakeLocal();
    const bridge = createSessionClearanceBridge(local);
    await bridge.write('office-pending');
    expect(bridge.acknowledged()).toBe('office-pending');

    // A subsequent 'allowed' push the main process refuses must not silently
    // open the fence.
    local.setSessionClearance = async () => {
      local.calls.push('allowed');
      throw new Error('ipc channel closed');
    };
    await bridge.write('allowed');

    expect(bridge.acknowledged()).toBe('office-pending');
    expect(await clearanceAllowsWorkspace(bridge)).toBe(false);
  });

  it('whenApplied resolves once the newest write has been acknowledged', async () => {
    const local = makeFakeLocal({ gate: true });
    const bridge = createSessionClearanceBridge(local);

    let settled = false;
    void bridge.write('office-pending');
    void bridge.whenApplied().then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    local.gateResolver?.();
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it('satisfies the fence locally when there is no bridge at all', async () => {
    // Offline/demo/renderer without the preload: no main process to fence.
    const bridge = createSessionClearanceBridge(null);
    await bridge.write('allowed');
    expect(bridge.acknowledged()).toBe('allowed');
    expect(await clearanceAllowsWorkspace(bridge)).toBe(true);
  });

  it('refuses the workspace while the acknowledged clearance is office-pending', async () => {
    const local = makeFakeLocal();
    const bridge = createSessionClearanceBridge(local);
    await bridge.write('office-pending');
    expect(await clearanceAllowsWorkspace(bridge)).toBe(false);

    await bridge.write('allowed');
    expect(await clearanceAllowsWorkspace(bridge)).toBe(true);
  });
});
