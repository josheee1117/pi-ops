import type { NotificationPayload } from './notification.js';
import { toOnCallBrief } from './on-call-brief.js';

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

/** Plain Chinese for the fault types the detectors actually emit. */
const FAULT_COPY: Record<string, { name: string; open: string; recovered: string }> = {
  'health.failure': {
    name: '健康检查失败',
    open: '健康检查连续没有通过，服务可能已经不可用。',
    recovered: '健康检查重新通过。',
  },
  'container.die': {
    name: '容器退出',
    open: '容器进程退出了，服务不在运行。',
    recovered: '容器已重新运行。',
  },
  'container.restart': {
    name: '容器重启',
    open: '容器刚刚异常重启。',
    recovered: '容器重启后已稳定。',
  },
  'container.oom': {
    name: '容器内存不足被杀',
    open: '容器因为内存不足被系统杀掉。',
    recovered: '容器内存不足的情况已过去。',
  },
  'jvm.oom': {
    name: 'Java 内存耗尽',
    open: 'Java 进程内存耗尽（OutOfMemoryError）。',
    recovered: 'Java 内存耗尽的情况已过去。',
  },
  'jvm.stack_overflow': {
    name: 'Java 栈溢出',
    open: 'Java 进程栈溢出（StackOverflowError）。',
    recovered: 'Java 栈溢出的情况已过去。',
  },
  'business.error': {
    name: '接口报错',
    open: '应用接口出现未处理异常。',
    recovered: '应用接口报错已恢复。',
  },
  'host.memory_pressure': {
    name: '机器内存过高',
    open: '机器内存占用持续过高。',
    recovered: '机器内存占用已回到正常范围。',
  },
  'host.disk_pressure': {
    name: '磁盘空间不足',
    open: '机器磁盘占用持续过高。',
    recovered: '机器磁盘空间已恢复。',
  },
  'application.slow_sql': {
    name: '慢 SQL',
    open: '数据库出现慢 SQL。',
    recovered: '慢 SQL 已恢复。',
  },
  'jvm.cpu_pressure': {
    name: 'Java CPU 过高',
    open: 'Java 进程 CPU 占用持续过高。',
    recovered: 'Java 进程 CPU 占用已回落。',
  },
  'jvm.gc_pressure': {
    name: 'Java 垃圾回收过频',
    open: 'Java 垃圾回收过于频繁。',
    recovered: 'Java 垃圾回收已恢复正常。',
  },
};

function beijingTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('month')}月${pick('day')}日 ${pick('hour')}:${pick('minute')}`;
}

function describeFault(type: string, service: string, recovered: boolean): { title: string; body: string } {
  const known = FAULT_COPY[type];
  if (!known) {
    return recovered
      ? { title: `${service} 已恢复`, body: `${type} 已恢复。` }
      : { title: `${service} 发生故障`, body: `故障类型是 ${type}。` };
  }
  return recovered
    ? { title: `${service} 已恢复`, body: known.recovered }
    : { title: `${service} ${known.name}`, body: known.open };
}

function formatWeComMarkdown(notification: NotificationPayload): string {
  const incident = notification.incident;
  const recovered = notification.type === 'INCIDENT_RECOVERED';
  const completedAfterRecovery = notification.type === 'INVESTIGATION_COMPLETED' && incident.state === 'RECOVERED';
  const described = describeFault(incident.type, incident.service, recovered);
  const title = notification.type === 'INVESTIGATION_COMPLETED'
    ? `${incident.service} 诊断完成${completedAfterRecovery ? '（故障已恢复）' : ''}`
    : described.title;
  const body = completedAfterRecovery ? '故障已在诊断完成前恢复，以下是诊断时的判断。' : described.body;
  const when = beijingTime(notification.type === 'INCIDENT_OPEN' || completedAfterRecovery ? incident.firstSeen : incident.lastSeen);
  const analysis = notification.type === 'INVESTIGATION_COMPLETED' ? notification.analysis : undefined;
  const time = `${completedAfterRecovery ? '发生时间' : '时间'}：${when}`;
  const lines = [`### ${title}`];
  if (completedAfterRecovery) lines.push(body);
  if (analysis) {
    const brief = toOnCallBrief(analysis.hypothesis, analysis.recommendation);
    lines.push(`**${brief.conclusion.replaceAll('*', '')}**`);
    if (!completedAfterRecovery) lines.push(body);
    lines.push(`机器：${incident.nodeId}`, time);
    if (brief.evidence) lines.push('', '**依据**', brief.evidence);
    if (brief.unknown) lines.push('', '**未知**', brief.unknown);
    if (brief.steps.length > 0) lines.push('', '**下一步**', ...brief.steps.map((step, index) => `${index + 1}. ${step}`));
    lines.push('', `<font color="comment">模型自评 ${Math.round(analysis.confidence * 100)}%，不是准确率</font>`);
  } else {
    if (!completedAfterRecovery) lines.push(body);
    lines.push(`机器：${incident.nodeId}`, time);
  }
  lines.push('', `编号：${incident.id}`);
  const content = lines.join('\n');
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
