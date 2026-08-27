import type { NotificationPayload } from './notification.js';

export interface Notifier {
  send(notification: NotificationPayload): Promise<void>;
}

export class RetryableNotificationError extends Error {
  readonly retryable = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'RetryableNotificationError';
  }
}

export class TerminalNotificationError extends Error {
  readonly retryable = false as const;

  constructor(message: string) {
    super(message);
    this.name = 'TerminalNotificationError';
  }
}

export function isRetryableNotificationError(error: unknown): boolean {
  if (error instanceof RetryableNotificationError) return true;
  if (error instanceof TerminalNotificationError) return false;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return error instanceof TypeError;
}

export function createFakeNotifier() {
  const sent: NotificationPayload[] = [];
  const identities: string[] = [];
  const notifier: Notifier & { sent: NotificationPayload[]; identities: string[] } = {
    sent,
    identities,
    async send(notification) {
      sent.push(notification);
      identities.push(notification.notificationId);
    },
  };
  return notifier;
}

export function createHttpWebhookNotifier(options: {
  url: string;
  timeoutMs: number;
  maxResponseBytes: number;
  token?: string;
  fetch?: typeof fetch;
}): Notifier {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async send(notification) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'Idempotency-Key': notification.notificationId,
        };
        if (options.token) headers.authorization = `Bearer ${options.token}`;
        const response = await fetchImpl(options.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(notification),
          signal: controller.signal,
        });
        await drainBounded(response, options.maxResponseBytes);
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableNotificationError(`notification webhook ${response.status}`);
        }
        if (response.status >= 400) {
          throw new TerminalNotificationError(`notification webhook ${response.status}`);
        }
      } catch (error) {
        if (error instanceof RetryableNotificationError || error instanceof TerminalNotificationError) {
          throw error;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new RetryableNotificationError('notification webhook timeout');
        }
        throw new RetryableNotificationError('notification webhook connection error');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function drainBounded(response: Response, maxBytes: number): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return;
    }
  }
}
