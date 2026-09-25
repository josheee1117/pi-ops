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
      const signal = AbortSignal.timeout(options.timeoutMs);
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
          signal,
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
        // Manual AbortController aborts surfaced as AbortError; the native
        // timeout signal surfaces as TimeoutError. Both are the timeout path.
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          throw new RetryableNotificationError('notification webhook timeout');
        }
        throw new RetryableNotificationError('notification webhook connection error');
      }
    },
  };
}

function formatWeComMarkdown(notification: NotificationPayload): string {
  const incident = notification.incident;
  const titles = {
    INCIDENT_OPEN: '🚨 Incident OPEN',
    INVESTIGATION_COMPLETED: '🔎 Investigation COMPLETED',
    INCIDENT_RECOVERED: '✅ Incident RECOVERED',
  };
  const lines = [
    `### ${titles[notification.type]}`,
    `> service: ${incident.service}`,
    `> node: ${incident.nodeId}`,
    `> type: ${incident.type}`,
    `> time: ${notification.type === 'INCIDENT_OPEN' ? incident.firstSeen : incident.lastSeen}`,
    `> eventCount: ${notification.facts.eventCount}`,
    `> evidence: ${notification.facts.evidenceIds.length}`,
  ];
  const analysis = notification.type === 'INVESTIGATION_COMPLETED' ? notification.analysis : undefined;
  if (analysis) lines.push(`> hypothesis: ${analysis.hypothesis} (${analysis.confidence})`, `> recommendation: ${analysis.recommendation}`);
  lines.push(`> incident id: ${incident.id}`);
  let content = lines.join('\n');
  for (const field of ['recommendation', 'hypothesis'] as const) {
    if (Buffer.byteLength(content) <= 4000 || !analysis) break;
    const bytes = Buffer.from(analysis[field]);
    let end = Math.max(0, bytes.length - (Buffer.byteLength(content) - 4000));
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    const value = bytes.subarray(0, end).toString('utf8');
    lines[lines.length - (field === 'recommendation' ? 2 : 3)] = field === 'recommendation'
      ? `> recommendation: ${value}` : `> hypothesis: ${value} (${analysis.confidence})`;
    content = lines.join('\n');
  }
  if (Buffer.byteLength(content) > 4000) throw new TerminalNotificationError('wecom notification facts exceed limit');
  return content;
}

export function createWeComNotifier(options: {
  webhookUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetch?: typeof fetch;
}): Notifier {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async send(notification) {
      const content = formatWeComMarkdown(notification);
      try {
        const response = await fetchImpl(options.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': notification.notificationId },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        let errcode: unknown;
        try {
          errcode = JSON.parse(await drainBounded(response, options.maxResponseBytes, true)).errcode;
        } catch {
          throw new TerminalNotificationError('wecom invalid response');
        }
        if (errcode === 45009) throw new RetryableNotificationError('wecom rate limited (45009)');
        if (!response.ok || errcode !== 0) throw new TerminalNotificationError(`wecom error ${response.status}${typeof errcode === 'number' ? ` code ${errcode}` : ''}`);
      } catch (error) {
        if (error instanceof RetryableNotificationError || error instanceof TerminalNotificationError) throw error;
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
          throw new RetryableNotificationError('wecom timeout');
        }
        throw new RetryableNotificationError('wecom connection error');
      }
    },
  };
}

async function drainBounded(response: Response, maxBytes: number, collect = false): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return collect ? Buffer.concat(chunks).toString('utf8') : '';
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return '';
    }
    if (collect) chunks.push(value);
  }
}
