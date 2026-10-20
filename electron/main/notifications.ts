import { Notification } from 'electron';

/** The only notification request shape accepted from the renderer. */
export interface DksNotificationRequest {
  title: string;
  body: string;
  silent?: boolean;
}

export type DksNotificationFailure =
  | 'invalid'
  | 'unsupported'
  | 'unavailable'
  | 'error';

export interface DksNotificationResult {
  delivered: boolean;
  reason?: DksNotificationFailure;
}

export interface NotificationInstance {
  show: () => void;
}

export interface NotificationDependencies {
  isSupported?: () => boolean;
  create?: (request: DksNotificationRequest) => NotificationInstance;
}

export interface NotificationService {
  show: (request: unknown) => DksNotificationResult;
}

export const NOTIFICATION_SHOW_CHANNEL = 'dks:notifications:show' as const;

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normaliseRequest(value: unknown): DksNotificationRequest | null {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.body !== 'string') {
    return null;
  }

  const title = value.title.trim().slice(0, MAX_TITLE_LENGTH);
  const body = value.body.trim().slice(0, MAX_BODY_LENGTH);

  if (!title || !body) {
    return null;
  }

  return {
    title,
    body,
    silent: value.silent === true,
  };
}

function defaultIsSupported(): boolean {
  try {
    return typeof Notification.isSupported !== 'function' || Notification.isSupported();
  } catch {
    return false;
  }
}

function defaultCreate(request: DksNotificationRequest): NotificationInstance {
  const options: Electron.NotificationConstructorOptions = {
    title: request.title,
    body: request.body,
  };

  if (request.silent !== undefined) {
    options.silent = request.silent;
  }

  return new Notification(options);
}

/**
 * Create a deliberately small notification boundary.
 *
 * Electron notification support varies by operating system and can fail at
 * construction time (for example when a desktop notification service is not
 * available). All failures are converted into a result so notification work
 * never takes down the main process.
 */
export function createNotificationService(
  dependencies: NotificationDependencies = {},
): NotificationService {
  const isSupported = dependencies.isSupported ?? defaultIsSupported;
  const create = dependencies.create ?? defaultCreate;

  return {
    show(request: unknown): DksNotificationResult {
      const normalised = normaliseRequest(request);
      if (!normalised) {
        return { delivered: false, reason: 'invalid' };
      }

      try {
        if (!isSupported()) {
          return { delivered: false, reason: 'unsupported' };
        }

        create(normalised).show();
        return { delivered: true };
      } catch {
        return { delivered: false, reason: 'error' };
      }
    },
  };
}

/** A convenient default for callers that do not need dependency injection. */
export const notificationService = createNotificationService();
