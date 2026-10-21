import type { NotificationPayload } from './notification.js';
import { plainSummary } from './on-call-brief.js';

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

export function formatWeComMarkdown(notification: NotificationPayload, detailsBaseUrl = ''): string {
  const summary = plainSummary(notification);
  const status = notification.notice === 'manual-confirmation' ? '需要人工确认'
    : notification.notice === 'recovered-before-delivery' ? '曾发生、现已恢复'
      : notification.type === 'INCIDENT_RECOVERED' ? '已恢复'
        : notification.type === 'INVESTIGATION_COMPLETED' ? '诊断更新' : '故障通知';
  const text = (value: string) => value.replace(/[\r\n]/g, ' ').replace(/[<>*`]/g, '');
  const url = `${detailsBaseUrl.replace(/\/$/, '')}/v1/ops/incidents/${encodeURIComponent(notification.incident.id)}/brief?format=markdown`;
  return [
    `### ${status}`,
    `场景：${text(summary.scene)}`,
    `发生了什么：${text(summary.whatHappened)}`,
    `严重程度：${summary.severity.level}，${text(summary.severity.reason)}`,
    '恢复建议：', ...summary.recovery.map((item, index) => `${index + 1}. ${text(item)}`),
    `编号：${text(notification.incident.id)}`,
    `详情获取方式：GET ${url}`,
    '鉴权：Authorization: Bearer <运维令牌>，令牌从安全渠道获取，不放进消息。',
  ].join('\n');
}

export function createWeComNotifier(options: {
  webhookUrl: string;
  detailsBaseUrl?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetch?: typeof fetch;
}): Notifier {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async send(notification) {
      const content = formatWeComMarkdown(notification, options.detailsBaseUrl);
      try {
        const response = await fetchImpl(options.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': notification.notificationId },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        const body = await drainBounded(response, options.maxResponseBytes, true);
        if (response.status === 429 || response.status >= 500) {
          throw new RetryableNotificationError(`wecom webhook ${response.status}`);
        }
        if (!response.ok) throw new TerminalNotificationError(`wecom webhook ${response.status}`);
        let errcode: unknown;
        try {
          errcode = JSON.parse(body).errcode;
        } catch {
          throw new TerminalNotificationError('wecom invalid response');
        }
        if (errcode === 45009) throw new RetryableNotificationError('wecom rate limited (45009)');
        if (errcode !== 0) throw new TerminalNotificationError(`wecom error code ${typeof errcode === 'number' ? errcode : 'invalid'}`);
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
