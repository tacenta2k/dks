import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export interface BackupCopyResult {
  /** A safe filename only; no machine-specific source path or secret is returned. */
  fileName: string;
  bytes: number;
  createdAt: string;
  sha256: string;
}

export interface BackupCopyOptions {
  sourcePath: string;
  destinationPath: string;
  now?: () => string;
}

export interface BackupDatabaseSource {
  /** Main-process-only copy operation; the renderer never receives a path. */
  backupTo: (destinationPath: string) => Promise<void>;
}

function safeFileName(value: string): string {
  const name = basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!name || name === '.' || name === '..') {
    return 'dks-backup.sqlite';
  }
  return name;
}

function rejectSecretLikePath(value: string): void {
  const lower = basename(value).toLowerCase();
  if (
    lower === '.env'
    || lower.startsWith('.env.')
    || lower.includes('secret')
    || lower.includes('token')
    || lower.includes('credential')
    || lower.includes('password')
  ) {
    throw new Error('Backup paths must refer to the protected application database');
  }
}

async function checksum(path: string): Promise<string> {
  const contents = await readFile(path);
  return createHash('sha256').update(contents).digest('hex');
}

/** Copy one app-owned database file and return metadata without its path. */
export function createBackupCopy(options: BackupCopyOptions): Promise<BackupCopyResult>;
export function createBackupCopy(
  sourcePath: string,
  destinationPath: string,
  now?: () => string,
): Promise<BackupCopyResult>;
export async function createBackupCopy(
  optionsOrSource: BackupCopyOptions | string,
  destinationPath?: string,
  clock?: () => string,
): Promise<BackupCopyResult> {
  const options: BackupCopyOptions = typeof optionsOrSource === 'string'
    ? {
        sourcePath: optionsOrSource,
        destinationPath: destinationPath ?? '',
        now: clock,
      }
    : optionsOrSource;
  rejectSecretLikePath(options.sourcePath);
  rejectSecretLikePath(options.destinationPath);
  await mkdir(dirname(options.destinationPath), { recursive: true });
  await copyFile(options.sourcePath, options.destinationPath);

  const details = await stat(options.destinationPath);
  const timestamp = options.now ?? (() => new Date().toISOString());
  return {
    fileName: safeFileName(options.destinationPath),
    bytes: details.size,
    createdAt: timestamp(),
    sha256: await checksum(options.destinationPath),
  };
}

/** Convenience overload for callers that already selected the exact path. */
export async function copyDatabaseBackup(
  sourcePath: string,
  destinationPath: string,
  now?: () => string,
): Promise<BackupCopyResult> {
  return createBackupCopy({ sourcePath, destinationPath, now });
}

export const backupDatabaseCopy = copyDatabaseBackup;
export const copyAppDatabase = copyDatabaseBackup;

function generatedBackupName(now: string): string {
  const stamp = now.replace(/[^0-9]/g, '').slice(0, 14) || '00000000000000';
  return `dks-backup-${stamp}.sqlite`;
}

/**
 * Copy through the protected main-process source abstraction.  The source can
 * be a live better-sqlite3 handle internally, but its path/raw handle never
 * crosses this function's result boundary.
 */
export function backupDatabase(
  source: BackupDatabaseSource,
  destinationDirectory: string,
  now?: () => string,
): Promise<BackupCopyResult>;
export function backupDatabase(
  sourcePath: string,
  destinationDirectory: string,
  now?: () => string,
): Promise<BackupCopyResult>;
export async function backupDatabase(
  sourceOrPath: BackupDatabaseSource | string,
  destinationDirectory: string,
  now: () => string = () => new Date().toISOString(),
): Promise<BackupCopyResult> {
  const createdAt = now();
  const destinationPath = join(destinationDirectory, generatedBackupName(createdAt));
  rejectSecretLikePath(destinationPath);
  await mkdir(destinationDirectory, { recursive: true });
  if (typeof sourceOrPath === 'string') {
    rejectSecretLikePath(sourceOrPath);
    await copyFile(sourceOrPath, destinationPath);
  } else {
    await sourceOrPath.backupTo(destinationPath);
  }

  const details = await stat(destinationPath);
  return {
    fileName: safeFileName(destinationPath),
    bytes: details.size,
    createdAt,
    sha256: await checksum(destinationPath),
  };
}

export const createDatabaseBackup = backupDatabase;
export const backupProtectedDatabase = backupDatabase;

/** Guard against accidentally copying an unrelated source file into backups. */
export function isDatabaseBackupFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === '.sqlite' || extension === '.db' || extension === '.sqlite3';
}
