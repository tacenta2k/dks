import { describe, expect, it } from 'vitest';

import { resolveSyncIndicator } from '../src/lib/sync-indicator';

describe('top-bar sync indicator truthfulness (R2-12)', () => {
  it('never claims "Saved to cloud" while items are pending', () => {
    expect(resolveSyncIndicator('healthy', 2).label).toBe('Sync error · 2 pending');
    expect(resolveSyncIndicator('offline', 1).label).toBe('Sync error · 1 pending');
    expect(resolveSyncIndicator('error', 3).label).toBe('Sync error · 3 pending');
    expect(resolveSyncIndicator('healthy', 1).key).toBe('error');
  });

  it('shows Syncing… with the pending count while a flush is in flight', () => {
    expect(resolveSyncIndicator('syncing', 4)).toEqual({
      key: 'syncing',
      label: 'Syncing… · 4 pending',
      pendingSuffix: ' · 4 pending',
    });
  });

  it('only reports success for a healthy state with an empty outbox', () => {
    expect(resolveSyncIndicator('healthy', 0)).toEqual({
      key: 'cloud',
      label: 'Saved to cloud',
      pendingSuffix: '',
    });
  });

  it('keeps the offline wording when nothing is queued', () => {
    expect(resolveSyncIndicator('offline', 0).label).toBe('Offline — saved locally');
  });

  it('never reports error without pending work repeating a count', () => {
    expect(resolveSyncIndicator('error', 0).label).toBe('Sync error');
  });
});
