import type { SheetRepository } from '../features/sheet/repository';

/**
 * Local-mutation → sync flush trigger (Blocker 3).
 *
 * Historically the sync loop only ran on a 60s timer and realtime events, so
 * a local change could sit in the outbox for a minute (or forever when
 * realtime is unavailable) and the UI kept showing "N pending". Wrapping the
 * repository in this proxy reports every successful local mutation to the
 * app, which schedules an immediate (debounced) sync.
 *
 * Rules:
 *  - read-only methods (getColumns/getRows/getAuditHistory/getRenewalHistory)
 *    never trigger;
 *  - setRole is session state, not data — never triggers;
 *  - any other method triggers ONLY when its promise resolves (a rejected
 *    mutation changed nothing and must not burn a sync attempt);
 *  - the proxy never alters the repository's return value or rejection.
 */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'getColumns',
  'getRows',
  'getAuditHistory',
  'getRenewalHistory',
]);

const NON_TRIGGERING_METHODS: ReadonlySet<string> = new Set([
  'setRole',
]);

export function createSyncingRepositoryProxy<T extends SheetRepository>(
  repository: T,
  onMutate: () => void,
): T {
  return new Proxy(repository, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      const name = String(prop);
      if (READ_ONLY_METHODS.has(name) || NON_TRIGGERING_METHODS.has(name)) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          result.then(() => onMutate(), () => undefined);
        }
        return result;
      };
    },
  });
}
