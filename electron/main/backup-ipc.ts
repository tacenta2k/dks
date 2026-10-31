import type { BackupService } from './backup-service';
import { assertSafeObjectKey } from './backup-client';
import { describeFailure } from './backup-service';
import type {
  BackupDrillResult,
  BackupHealthResult,
  BackupHistoryEntry,
  BackupIpcChannel,
  BackupKeySetupResult,
  BackupListResult,
  BackupRunResult,
  BackupState,
  BackupTrigger,
} from './backup-types';
import { BACKUP_IPC_CHANNELS } from './backup-types';
import type { LocalIpcMain, LocalSessionClearance, LocalSessionRole } from './local-ipc';

/**
 * Cloud-backup IPC surface.
 *
 * Admin enforcement lives HERE, in the main process — the same shape as
 * `diagnostics-ipc.ts`: the payload must carry `role: 'admin'`, the reported
 * session role must not be 'office', and an Office session awaiting approval
 * is refused outright. The preload bridge validates the same fields first as
 * defence-in-depth, never as the boundary.
 *
 * The Worker is the real authority: it verifies the signed Supabase JWT and
 * looks the role up in Postgres itself, so nothing here can widen access.
 */

export interface BackupIpcDependencies {
  service: BackupService;
  sessionClearance?: () => LocalSessionClearance;
  sessionRole?: () => LocalSessionRole | null;
}

export type BackupIpcHandler = (payload?: unknown) => unknown;
export type BackupIpcHandlers = Readonly<Record<BackupIpcChannel, BackupIpcHandler>>;

const TRIGGERS: ReadonlySet<string> = new Set(['launch', 'quit', 'hourly', 'manual']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireAdmin(
  payload: unknown,
  clearance: LocalSessionClearance,
  reportedRole: LocalSessionRole | null,
): void {
  if (clearance === 'office-pending') {
    throw new Error('administrator role is required');
  }
  // The reported session role is authoritative: anything that is not an admin
  // session is refused, whatever the renderer claims in its payload.
  if (reportedRole !== null && reportedRole !== 'admin') {
    throw new Error('administrator role is required');
  }
  if (!isRecord(payload) || payload.role !== 'admin') {
    throw new Error('administrator role is required');
  }
}

function requireSignedIn(
  payload: unknown,
  clearance: LocalSessionClearance,
): 'admin' | 'office' {
  if (clearance === 'office-pending') {
    throw new Error('Waiting for admin approval — this session cannot use cloud backup.');
  }
  if (!isRecord(payload) || (payload.role !== 'admin' && payload.role !== 'office')) {
    throw new Error('authenticated session role is required');
  }
  return payload.role;
}

function yearFrom(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('a valid year is required');
  }
  const year = value;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('a valid year is required');
  }
  return year;
}

function monthFrom(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('a valid month is required');
  }
  const month = value;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('a valid month is required');
  }
  return month;
}

function triggerFrom(value: unknown): BackupTrigger {
  return typeof value === 'string' && TRIGGERS.has(value) ? value as BackupTrigger : 'manual';
}

export function createBackupIpcHandlers(dependencies: BackupIpcDependencies): BackupIpcHandlers {
  const getClearance = dependencies.sessionClearance ?? ((): LocalSessionClearance => 'allowed');
  const getRole = dependencies.sessionRole ?? ((): LocalSessionRole | null => null);

  return Object.freeze({
    [BACKUP_IPC_CHANNELS.getState]: (payload: unknown): BackupState => {
      requireAdmin(payload, getClearance(), getRole());
      return dependencies.service.getState();
    },

    [BACKUP_IPC_CHANNELS.runNow]: (payload: unknown): Promise<BackupRunResult> => {
      requireAdmin(payload, getClearance(), getRole());
      const trigger = isRecord(payload) ? triggerFrom(payload.trigger) : 'manual';
      return dependencies.service.runNow(trigger);
    },

    [BACKUP_IPC_CHANNELS.list]: (payload: unknown): Promise<BackupListResult> => {
      requireAdmin(payload, getClearance(), getRole());
      const input = isRecord(payload) ? payload : {};
      return dependencies.service.list({
        year: yearFrom(input.year),
        month: monthFrom(input.month),
        cursor: typeof input.cursor === 'string' && input.cursor.length > 0 ? input.cursor : null,
      });
    },

    [BACKUP_IPC_CHANNELS.download]: (payload: unknown): Promise<{ filePath: string; sizeBytes: number; sha256: string }> => {
      requireAdmin(payload, getClearance(), getRole());
      const input = isRecord(payload) ? payload : {};
      if (typeof input.objectKey !== 'string' || input.objectKey.trim().length === 0) {
        throw new Error('a backup object key is required');
      }
      return dependencies.service.download(assertSafeObjectKey(input.objectKey));
    },

    [BACKUP_IPC_CHANNELS.testDrill]: (payload: unknown): Promise<BackupDrillResult> => {
      requireAdmin(payload, getClearance(), getRole());
      const input = isRecord(payload) ? payload : {};
      const recoveryKey = typeof input.recoveryKey === 'string' ? input.recoveryKey : undefined;
      return dependencies.service.testDrill(recoveryKey);
    },

    [BACKUP_IPC_CHANNELS.setupKey]: (payload: unknown): BackupKeySetupResult => {
      requireAdmin(payload, getClearance(), getRole());
      const input = isRecord(payload) ? payload : {};
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'configure') {
        // Not part of the original key-wizard steps: the admin status card's
        // on/off toggle and the service address both need a write path, and
        // this channel is already the admin-enforced configuration surface.
        try {
          if (typeof input.workerUrl === 'string' && input.workerUrl.trim()) {
            dependencies.service.setWorkerUrl(input.workerUrl);
          }
          if (typeof input.enabled === 'boolean') {
            dependencies.service.setEnabled(input.enabled);
          }
        } catch (error) {
          return { ok: false, message: describeFailure(error, 'That backup setting could not be saved') };
        }
        return { ok: true, message: 'Backup settings saved' };
      }
      if (action === 'generate') {
        if (typeof input.workerUrl === 'string' && input.workerUrl.trim()) {
          try {
            dependencies.service.setWorkerUrl(input.workerUrl);
          } catch (error) {
            return { ok: false, message: describeFailure(error, 'That backup service address is not usable') };
          }
        }
        return dependencies.service.setupKeyGenerate();
      }
      if (action === 'confirm') {
        if (typeof input.recoveryKey !== 'string') {
          return { ok: false, message: 'Enter the recovery key to confirm it' };
        }
        return dependencies.service.setupKeyConfirm(input.recoveryKey);
      }
      if (action === 'import') {
        // Replacement-PC path: the administrator pastes the recovery key that
        // was shown once on the old machine. `keyId` is optional and, when
        // supplied, must match the key being imported — that is how the UI can
        // prove the key belongs to the backup the admin is trying to open.
        if (typeof input.recoveryKey !== 'string' || input.recoveryKey.trim().length === 0) {
          return { ok: false, message: 'Enter the recovery key to import it' };
        }
        const expectedKeyId = typeof input.keyId === 'string' && input.keyId.trim().length > 0
          ? input.keyId.trim().toLowerCase()
          : null;
        return dependencies.service.setupKeyImport(input.recoveryKey, expectedKeyId);
      }
      return { ok: false, message: 'Unknown key setup step' };
    },

    [BACKUP_IPC_CHANNELS.healthCheck]: (payload: unknown): Promise<BackupHealthResult> => {
      requireAdmin(payload, getClearance(), getRole());
      return dependencies.service.healthCheck();
    },

    /**
     * Session credential push. Not admin-gated on purpose: an approved Office
     * session may also upload (the Worker enforces the Office approval check),
     * and refusing here would silently disable backups on Office PCs. Passing
     * `null` clears the credential on sign-out.
     */
    [BACKUP_IPC_CHANNELS.setSession]: (payload: unknown): { ok: boolean } => {
      if (payload === null || payload === undefined) {
        // Sign-out: drop the credential so no upload can be attempted.
        dependencies.service.setSession(null);
        return { ok: true };
      }
      const role = requireSignedIn(payload, getClearance());
      const accepted = dependencies.service.setSession({ ...(payload as Record<string, unknown>), role });
      return { ok: accepted };
    },
  });
}

export function registerBackupIpcHandlers(
  dependencies: BackupIpcDependencies & { ipcMain: LocalIpcMain },
): () => void {
  const handlers = createBackupIpcHandlers(dependencies);
  const channels = Object.values(BACKUP_IPC_CHANNELS);

  for (const channel of channels) {
    dependencies.ipcMain.removeHandler?.(channel);
    dependencies.ipcMain.handle(channel, (_event, payload) => handlers[channel](payload));
  }

  return () => {
    for (const channel of channels) {
      dependencies.ipcMain.removeHandler?.(channel);
    }
  };
}

export type { BackupHistoryEntry };
