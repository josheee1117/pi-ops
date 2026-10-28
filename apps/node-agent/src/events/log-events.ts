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
import { dockerLogRecord, type DockerLogRecord } from '../evidence/docker.js';
import { scanRawRecords, coalesceLogEvents } from './log-records.js';

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

  // Keep the existing JFR identity before renaming its stack output field.
  const id = stableId(['docker.logs', source.nodeId, source.container, resolvedType, observedAt ?? eventTime, attributes]);
  attributes['stackTrace'] = attributes['stackTrace'] ?? attributes['exceptionStackTrace'] ?? '';
  delete attributes['exceptionStackTrace'];
  attributes['logRecordCount'] = 1;

  return {
    schemaVersion: 1,
    id,
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

export interface ContainerLogScanResult {
  events: OpsEvent[];
  pending: DockerLogRecord[];
  unfinishedDropped: number;
}

export function scanContainerRecords(
  records: readonly DockerLogRecord[],
  source: LogScanSource,
  instrumented: boolean,
  recentFatal: ReadonlySet<string> = new Set(),
  deferIncomplete = false,
  settledRecords: ReadonlySet<DockerLogRecord> = new Set(),
): ContainerLogScanResult {
  const events: OpsEvent[] = [];
  const fatalFromPayload = new Set(recentFatal);
  for (const record of records) {
    const payload = jfrPayload(record.body);
    if (!payload) continue;
    const event = fromJfrPayload(payload, source);
    if (!event) continue;
    if (event.type === 'jvm.oom') fatalFromPayload.add('java.lang.OutOfMemoryError');
    if (event.type === 'jvm.stack_overflow') fatalFromPayload.add('java.lang.StackOverflowError');
    events.push(event);
  }
  const raw = scanRawRecords(records, source, instrumented || hasJfrPayload(records.map((record) => record.body)), fatalFromPayload, deferIncomplete, settledRecords);
  return { ...raw, events: coalesceLogEvents([...events, ...raw.events]) };
}

/** Stateless entry point for complete batches and fixture replay. */
export function scanContainerLog(
  lines: readonly (string | DockerLogRecord)[],
  source: LogScanSource,
  instrumented: boolean,
  recentFatal?: ReadonlySet<string>,
): OpsEvent[] {
  return scanContainerRecords(lines.map((line) => typeof line === 'string' ? dockerLogRecord(line) : line), source, instrumented, recentFatal).events;
}

/** True when the container's log carries Pi-Ops JFR payload lines. */
export function hasJfrPayload(lines: readonly string[]): boolean {
  return lines.some((line) => line.includes(JFR_LOG_PREFIX));
}
