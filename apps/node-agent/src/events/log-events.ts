/**
 * Container-log recognition for deployments with no event sender.
 *
 * Two recognition modes, and the distinction is load-bearing:
 *
 * 1. The Pi-Ops starter logs every JFR event to stdout as `[PI_OPS_JFR] {json}`.
 *    When the sender is off, that line is the only copy of a real JFR event, so
 *    recovering it is faithful reporting, not a lookalike. Provenance stays
 *    `application`, and the fingerprint matches the sender path so one fault
 *    still yields one Incident.
 * 2. Plain JVM fatal errors (`OutOfMemoryError`, `StackOverflowError`) appear in
 *    any Java app's logs, instrumented or not. These are observed through the
 *    Docker log API, so provenance is `docker`.
 *
 * The generic uncaught-exception rule is disabled once a container shows JFR
 * payload lines: that app already reports its own exceptions, and enabling both
 * would report one fault twice with different identities.
 */
import { createHash } from 'node:crypto';
import type { OpsEvent } from '@pi-ops/protocol';

export const JFR_LOG_PREFIX = '[PI_OPS_JFR] ';

export interface LogScanSource {
  container: string;
  nodeId: string;
  service: string;
}

/** JFR payload types worth forwarding from a log scan. Telemetry is excluded. */
const JFR_LOG_TYPES: Record<string, { type: string; severity: OpsEvent['severity'] }> = {
  BUSINESS_ERROR: { type: 'business.error', severity: 'error' },
  JVM_OOM: { type: 'jvm.oom', severity: 'critical' },
  JVM_STACK_OVERFLOW: { type: 'jvm.stack_overflow', severity: 'critical' },
};

const OOM_RE = /\bjava\.lang\.OutOfMemoryError\b/;
const STACK_OVERFLOW_RE = /\bjava\.lang\.StackOverflowError\b/;
const EXCEPTION_HEAD_RE = /^\s*(?:[\w$]+\.)+[\w$]*(?:Exception|Error)\b/;
const STACK_FRAME_RE = /^\s+at\s/;

function stableId(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/** Extracts an ISO-8601 timestamp from standard log prefixes if present. */
export function extractLogTimestamp(line: string): string | undefined {
  if (!line || typeof line !== 'string') return undefined;
  // ISO format: 2026-10-12T08:02:00.029...
  const isoMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/.exec(line.trim());
  if (isoMatch && isoMatch[1]) {
    const d = Date.parse(isoMatch[1]);
    if (!Number.isNaN(d)) return new Date(d).toISOString();
  }
  // Logback standard: 2026-10-12 08:02:00.028
  const stdMatch = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(line.trim());
  if (stdMatch && stdMatch[1] && stdMatch[2]) {
    const isoStr = `${stdMatch[1]}T${stdMatch[2]}Z`;
    const d = Date.parse(isoStr);
    if (!Number.isNaN(d)) return new Date(d).toISOString();
  }
  return undefined;
}

/** `/auth/lab/server-fault` from `GET /auth/lab/server-fault`. */
export function operationModule(operation: unknown): string | undefined {
  const text = bounded(operation, 256);
  if (!text) return undefined;
  const match = /^\s*(?:[A-Z]+)\s+(\S+)/.exec(text);
  return match ? match[1] : text;
}

function jfrPayload(line: string): Record<string, unknown> | undefined {
  const index = line.indexOf(JFR_LOG_PREFIX);
  if (index < 0) return undefined;
  const raw = line.slice(index + JFR_LOG_PREFIX.length).trim();
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function fromJfrPayload(
  payload: Record<string, unknown>,
  source: LogScanSource,
): OpsEvent | undefined {
  const rawType = bounded(payload['type'], 64);
  if (!rawType) return undefined;
  const known = JFR_LOG_TYPES[rawType];
  if (!known) return undefined;

  const attributes =
    payload['attributes'] && typeof payload['attributes'] === 'object' && !Array.isArray(payload['attributes'])
      ? { ...(payload['attributes'] as Record<string, unknown>) }
      : {};

  attributes['observedVia'] = 'docker.logs';
  attributes['producer'] = 'pi-ops-jfr';
  if (!attributes['containerName']) attributes['containerName'] = source.container;

  for (const key of ['exceptionClass', 'exceptionMessage', 'stackTrace', 'exceptionStackTrace', 'operation', 'module', 'errorCode', 'businessCode', 'businessType']) {
    const value = bounded(attributes[key], key === 'exceptionStackTrace' || key === 'stackTrace' ? 4096 : 256);
    if (value === undefined) delete attributes[key];
    else attributes[key] = value;
  }

  // Preserve responseStatus as integer when present
  if (typeof attributes['responseStatus'] === 'number' && Number.isInteger(attributes['responseStatus'])) {
    // keep as is
  } else if (typeof attributes['responseStatus'] === 'string') {
    const parsed = parseInt(attributes['responseStatus'], 10);
    if (!Number.isNaN(parsed) && parsed >= 100 && parsed <= 599) {
      attributes['responseStatus'] = parsed;
    } else {
      delete attributes['responseStatus'];
    }
  } else {
    delete attributes['responseStatus'];
  }

  // The sender path stamps businessCode from errorCode; the fingerprint reads
  // businessCode first, so both paths must set it to merge into one Incident.
  if (!attributes['businessCode'] && attributes['errorCode']) {
    attributes['businessCode'] = attributes['errorCode'];
  }
  if (known.type === 'business.error' && !attributes['module']) {
    const derived = operationModule(attributes['operation']);
    if (derived) attributes['module'] = derived;
  }

  // A JVM Error recorded through the business-error recorder is still a JVM
  // Error. Reporting it as a business error would hide the real fault class.
  let resolvedType = known.type;
  const exceptionClass = bounded(attributes['exceptionClass'], 256) ?? '';
  if (resolvedType === 'business.error') {
    if (/OutOfMemoryError$/.test(exceptionClass)) resolvedType = 'jvm.oom';
    else if (/StackOverflowError$/.test(exceptionClass)) resolvedType = 'jvm.stack_overflow';
    // Matches the evidence projector: a business error needs a qualified
    // exception class, otherwise it carries no fault identity worth an Incident.
    else if (!/^[\w$]+(?:\.[\w$]+)+$/.test(exceptionClass)) return undefined;
  }

  const rawService = bounded(payload['service'], 128);
  const observedAt = bounded(payload['timestamp'], 40);
  const eventTime = observedAt && !Number.isNaN(Date.parse(observedAt)) ? observedAt : new Date().toISOString();
  const message =
    bounded(attributes['safeMessage'], 512)
    ?? (exceptionClass || undefined)
    ?? rawType;

  return {
    schemaVersion: 1,
    id: stableId(['docker.logs', source.nodeId, source.container, resolvedType, observedAt ?? eventTime, attributes]),
    time: eventTime,
    source: 'application',
    nodeId: source.nodeId,
    service: rawService ?? source.service,
    type: resolvedType,
    severity: resolvedType === 'business.error' ? known.severity : 'critical',
    message,
    attributes,
  };
}

function fatalErrorEvent(
  type: string,
  severity: OpsEvent['severity'],
  exceptionClass: string,
  message: string,
  stack: string[],
  source: LogScanSource,
  line: string,
  timestamp?: string,
): OpsEvent {
  const attributes: Record<string, unknown> = {
    observedVia: 'docker.logs',
    containerName: source.container,
    exceptionClass,
    exceptionMessage: message,
    stackTrace: stack.join('\n').slice(0, 4096),
  };
  const eventTime = timestamp ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    id: stableId(['docker.logs', source.nodeId, source.container, type, exceptionClass, eventTime, line.slice(0, 200)]),
    time: eventTime,
    source: 'docker',
    nodeId: source.nodeId,
    service: source.service,
    type,
    severity,
    message: `${exceptionClass}: ${message}`.slice(0, 512),
    attributes,
  };
}

/**
 * Recognizes faults in one container's log lines.
 *
 * `instrumented` must be true when the container's log showed JFR payload lines
 * at any point. Fatal JVM errors are still read from raw stacks, because the
 * starter has no event for them; only duplicate exception reporting is skipped.
 */
export function scanContainerLog(
  lines: readonly string[],
  source: LogScanSource,
  instrumented: boolean,
  recentFatal?: ReadonlySet<string>,
): OpsEvent[] {
  const events: OpsEvent[] = [];
  const fatalFromPayload = new Set<string>(recentFatal ?? []);

  // Pass 1: Recover all JFR payloads in this batch first, so any payload-reported
  // fatal error suppresses raw stack duplicates regardless of line order.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const payload = jfrPayload(line);
    if (!payload) continue;

    const event = fromJfrPayload(payload, source);
    if (!event) continue;

    if (event.type === 'jvm.oom' || event.type === 'jvm.stack_overflow') {
      const clazz = bounded(event.attributes['exceptionClass'], 256);
      if (clazz) fatalFromPayload.add(clazz);
      if (event.type === 'jvm.oom') fatalFromPayload.add('java.lang.OutOfMemoryError');
      if (event.type === 'jvm.stack_overflow') fatalFromPayload.add('java.lang.StackOverflowError');
    }
    events.push(event);
  }

  // Pass 2: Extract raw fatal errors and uninstrumented exceptions.
  let currentTimestamp: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineTs = extractLogTimestamp(line);
    if (lineTs) currentTimestamp = lineTs;

    // JFR payloads already processed in pass 1
    if (jfrPayload(line)) continue;

    const oom = OOM_RE.exec(line);
    if (oom) {
      if (fatalFromPayload.has('java.lang.OutOfMemoryError')) continue;
      const message = line.slice(oom.index + oom[0].length).replace(/^\s*[:|-]\s*/, '').trim();
      const stack: string[] = [];
      for (let next = index + 1; next < lines.length && STACK_FRAME_RE.test(lines[next] ?? ''); next += 1) {
        stack.push((lines[next] ?? '').trim());
      }
      events.push(fatalErrorEvent('jvm.oom', 'critical', 'java.lang.OutOfMemoryError', message, stack, source, line, currentTimestamp));
      continue;
    }

    const overflow = STACK_OVERFLOW_RE.exec(line);
    if (overflow) {
      if (fatalFromPayload.has('java.lang.StackOverflowError')) continue;
      const message = line.slice(overflow.index + overflow[0].length).replace(/^\s*[:|-]\s*/, '').trim();
      const stack: string[] = [];
      for (let next = index + 1; next < lines.length && STACK_FRAME_RE.test(lines[next] ?? ''); next += 1) {
        stack.push((lines[next] ?? '').trim());
      }
      events.push(fatalErrorEvent('jvm.stack_overflow', 'critical', 'java.lang.StackOverflowError', message, stack, source, line, currentTimestamp));
      continue;
    }

    // Raw exception stacks duplicate what an instrumented container reports.
    if (instrumented) continue;
    if (!EXCEPTION_HEAD_RE.test(line)) continue;

    const className = EXCEPTION_HEAD_RE.exec(line)?.[0]?.trim();
    if (!className) continue;
    const stack: string[] = [];
    for (let next = index + 1; next < lines.length && STACK_FRAME_RE.test(lines[next] ?? ''); next += 1) {
      stack.push((lines[next] ?? '').trim());
    }
    if (stack.length === 0) continue;

    const message = line.replace(className, '').replace(/^\s*[:|-]\s*/, '').trim();
    const attributes: Record<string, unknown> = {
      observedVia: 'docker.logs',
      containerName: source.container,
      errorCode: 'UNHANDLED_EXCEPTION',
      businessCode: 'UNHANDLED_EXCEPTION',
      module: className,
      exceptionClass: className,
      exceptionMessage: message,
      exceptionStackTrace: stack.join('\n').slice(0, 4096),
    };
    const eventTime = currentTimestamp ?? new Date().toISOString();
    events.push({
      schemaVersion: 1,
      id: stableId(['docker.logs', source.nodeId, source.container, 'business.error', className, eventTime, line.slice(0, 200)]),
      time: eventTime,
      source: 'docker',
      nodeId: source.nodeId,
      service: source.service,
      type: 'business.error',
      severity: 'error',
      message: `${className}: ${message}`.slice(0, 512),
      attributes,
    });
  }

  return events;
}

/** True when the container's log carries Pi-Ops JFR payload lines. */
export function hasJfrPayload(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes(JFR_LOG_PREFIX));
}
