import { validateOpsEvent, type OpsEvent } from '@pi-ops/protocol';
import { projectJfrSignalEvidence } from './jfr-evidence.js';
import { criticalOperationFor, DEFAULT_NOTIFICATION_POLICY, serviceNotificationPolicy, type NotificationPolicyConfig } from './notification-config.js';
import type { FirstNotificationFacts, NotificationObservation } from './notification-policy.js';
import type { EventStore, IncidentRow, StoredEvent } from './store.js';

/**
 * Read-only map from persisted events to first-notification facts.
 * producer_type and source are declarations accepted by the shared Bearer
 * entry. Consistency is not authentication of the producer, JFR, or Docker.
 */
export type NotificationFactReadStore =
  Pick<EventStore, 'getIncident' | 'getEvent' | 'findIncidentByEventId' | 'listEvidence'>;

export interface StoredNotificationFactRequest {
  incidentId: string;
  eventIds: readonly string[];
  policy?: NotificationPolicyConfig;
  now?: string;
}

const UNKNOWN = { kind: 'unknown' } as const;

interface QualifiedEvent {
  id: string;
  time: number;
  stored: StoredEvent;
  event: OpsEvent | undefined;
  attributes: Record<string, unknown> | undefined;
}

export function buildFirstNotificationFactsFromStore(
  store: NotificationFactReadStore,
  request: StoredNotificationFactRequest,
): FirstNotificationFacts {
  const incident = store.getIncident(request.incidentId);
  if (!incident) throw new Error(`Incident ${request.incidentId} does not exist`);
  const first = parsedTime(incident.first_seen);
  const last = parsedTime(incident.last_seen);
  if (first === undefined || last === undefined) throw new Error(`Incident ${incident.id} has invalid observation times`);
  const policy = request.policy ?? DEFAULT_NOTIFICATION_POLICY;
  const gaps: NonNullable<FirstNotificationFacts['gaps']> = [];

  const qualified: QualifiedEvent[] = [];
  for (const id of new Set(request.eventIds)) {
    const stored = store.getEvent(id);
    if (!stored) { gaps.push({ eventId: id, reason: 'invalid-event' }); continue; }
    if (!supported(stored)) { gaps.push({ eventId: id, reason: 'unsupported-source' }); continue; }
    const linked = store.findIncidentByEventId(id);
    if (!linked || linked.id !== incident.id) { gaps.push({ eventId: id, reason: 'invalid-event' }); continue; }
    if (stored.node_id !== incident.node_id || stored.service !== incident.service) { gaps.push({ eventId: id, reason: 'invalid-event' }); continue; }
    const time = parsedTime(stored.event_time);
    if (time === undefined || time < first || time > last) { gaps.push({ eventId: id, reason: 'invalid-event' }); continue; }
    const attributes = parseAttributes(stored.attributes);
    if (!attributes) gaps.push({ eventId: id, reason: 'invalid-event' });
    qualified.push({
      id,
      time,
      stored,
      attributes,
      event: attributes ? toOpsEvent(stored, attributes) : undefined,
    });
  }
  qualified.sort((left, right) => left.time - right.time || compareId(left.id, right.id));

  const observations: NotificationObservation[] = [];
  for (const item of qualified) {
    const converted = observationsFor(incident, item, policy);
    observations.push(...converted);
    if (converted.length === 0 && !item.stored.type.endsWith('_recovered') && !item.stored.type.endsWith('.recovered')) gaps.push({ eventId: item.id, reason: 'invalid-event' });
    if (converted.some((observation) => observation.kind === 'ordinary-error') && item.stored.type === 'business.error'
      && typeof item.attributes?.operation !== 'string' && typeof item.attributes?.module !== 'string') {
      gaps.push({ eventId: item.id, reason: 'operation-binding' });
    }
  }
  const ordinaryItems = qualified.filter((item) => item.event !== undefined && isOrdinarySignal(item.stored.type)
    && !(typeof item.attributes?.responseStatus === 'number' && item.attributes.responseStatus >= 400 && item.attributes.responseStatus < 500)
    && !expectedLogRule(policy, incident.service, item.stored.message, item.attributes));
  const servicePolicy = serviceNotificationPolicy(policy, incident.service);
  let runStart = ordinaryItems[0]?.time;
  let previous: number | undefined;
  let samples = 0;
  for (const item of ordinaryItems) {
    if (previous !== undefined && item.time - previous > servicePolicy.observationMaxGapMs) { runStart = item.time; samples = 0; }
    if (item.time !== previous) samples++;
    previous = item.time;
  }
  const due = runStart === undefined ? undefined : runStart + servicePolicy.unknownImpactWaitMs;
  const now = request.now ? Date.parse(request.now) : last;
  if (!Number.isFinite(now)) throw new Error(`Invalid notification evaluation time: ${request.now}`);
  const latchedResource = incident.state !== 'RECOVERED' && qualified.some((item) =>
    ['host.memory_pressure', 'host.disk_pressure'].includes(item.stored.type)
    && typeof item.attributes?.consecutiveSamples === 'number' && item.attributes.consecutiveSamples >= 1
    && typeof item.attributes.threshold === 'number' && typeof item.attributes.usagePercent === 'number'
    && item.attributes.usagePercent >= item.attributes.threshold * 100);
  if (due !== undefined && previous !== undefined && now >= due
    && (latchedResource || (samples >= 2 && now - previous <= servicePolicy.observationMaxGapMs))) {
    for (const observation of observations) {
      if (observation.kind === 'ordinary-error') observation.persistence = { kind: 'known', value: 'sustained' };
    }
  }
  for (const evidence of store.listEvidence(incident.id)) {
    const observed = Date.parse(evidence.collectedAt);
    if (evidence.status !== 'succeeded' || evidence.nodeId !== incident.node_id || !isRecord(evidence.data)
      || !Number.isFinite(observed) || observed < first || observed > now
      || (incident.state === 'RECOVERED' && observed > last)) continue;
    const state = isRecord(evidence.data.State) ? evidence.data.State : undefined;
    const finishedAt = state && typeof state.FinishedAt === 'string' ? Date.parse(state.FinishedAt) : NaN;
    if (evidence.kind === 'docker.inspect' && evidence.data.Name === `/${incident.service}`
      && state?.OOMKilled === true && finishedAt >= first && finishedAt <= observed) {
      observations.push({ kind: 'docker', dockerAction: '', oomKilled: true, exitCode: { kind: 'absent' }, source: { kind: 'evidence', id: evidence.id } });
    }
    if (evidence.kind === 'http.probe' && evidence.data.healthy === false) {
      const data = evidence.data;
      const rule = policy.healthRules.find((item) => item.nodeId === incident.node_id && item.service === incident.service
        && item.url === data.url && item.method === data.method);
      const failure = qualified.find((item) => item.stored.type === 'health.failure' && item.attributes?.url === data.url);
      if (rule && failure && observations.some((item) => item.kind === 'health' && item.binding.kind === 'bound')) {
        observations.push({ kind: 'health', binding: { kind: 'bound', target: rule.target, ruleId: rule.ruleId }, transition: { kind: 'failure' }, source: { kind: 'evidence', id: evidence.id } });
      }
    }
  }
  const unknownImpactDueAt = due !== undefined && (samples >= 2 || latchedResource) ? new Date(due).toISOString() : undefined;
  return { observations, ...(gaps.length ? { gaps } : {}), ...(unknownImpactDueAt ? { unknownImpactDueAt } : {}) };
}

function isOrdinarySignal(type: string): boolean {
  return ['business.error', 'jvm.cpu_pressure', 'jvm.gc_pressure', 'host.memory_pressure', 'host.disk_pressure', 'application.slow_sql'].includes(type);
}

function supported(stored: StoredEvent): boolean {
  if (stored.type.endsWith('_recovered') || stored.type.endsWith('.recovered')) return true;
  if (['application', 'node-agent'].includes(stored.producer_type)
    && ['jfr', 'application', 'docker'].includes(stored.source)
    && ['jvm.oom', 'jvm.stack_overflow', 'runtime.oom', 'runtime.stack_overflow', 'business.error', 'jvm.cpu_pressure', 'jvm.gc_pressure', 'application.slow_sql'].includes(stored.type)) return true;
  if (stored.producer_type === 'node-agent' && stored.source === 'host'
    && ['host.memory_pressure', 'host.disk_pressure'].includes(stored.type)) return true;
  if (stored.producer_type === 'node-agent' && stored.source === 'docker'
    && (stored.type === 'container.oom' || stored.type === 'container.die')) return true;
  return stored.producer_type === 'node-agent' && stored.source === 'health' && stored.type === 'health.failure';
}

function observationsFor(incident: IncidentRow, item: QualifiedEvent, policy: NotificationPolicyConfig): NotificationObservation[] {
  const source = { kind: 'event' as const, id: item.id };
  if (item.stored.type.endsWith('_recovered') || item.stored.type.endsWith('.recovered')) return [];
  if (item.stored.type === 'business.error') {
    const exception = item.event ? oomeObservation(incident, item.event) : undefined;
    if (exception) return [ordinary(source), exception];
    const status = item.attributes?.responseStatus;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return [{ kind: 'expected-rejection', failures: UNKNOWN, requests: UNKNOWN, source }];
    }
    const operation = typeof item.attributes?.operation === 'string' ? item.attributes.operation
      : typeof item.attributes?.module === 'string' && item.attributes.module.startsWith('/') ? item.attributes.module : '';
    const binding = criticalOperationFor(serviceNotificationPolicy(policy, incident.service), operation);
    if (binding && item.event && (typeof status === 'number' && status >= 500
      || typeof item.attributes?.exceptionClass === 'string' && /^[\w$]+(?:\.[\w$]+)+$/.test(item.attributes.exceptionClass))) {
      return [{ kind: 'critical-operation', operation: binding.operation ?? binding.path ?? operation, ruleId: binding.ruleId, workflow: binding.workflow, source }];
    }
    const ignored = expectedLogRule(policy, incident.service, item.stored.message, item.attributes);
    if (ignored) return [{ kind: 'expected-rejection', failures: UNKNOWN, requests: UNKNOWN, source, ruleId: ignored.ruleId }];
    return [ordinary(source)];
  }
  if (item.stored.type === 'runtime.oom' || item.stored.type === 'runtime.stack_overflow') {
    const fatal = item.event ? runtimeFatalObservation(incident, item.event) : undefined;
    return fatal ? [fatal] : [];
  }
  if (item.stored.type === 'jvm.oom' || item.stored.type === 'jvm.stack_overflow') {
    const exception = item.event ? exceptionObservation(incident, item.event) : undefined;
    return exception ? [exception] : [];
  }
  if (item.stored.source === 'docker' && ['container.oom', 'container.die'].includes(item.stored.type)) {
    if (!item.attributes || !item.event || metadataConflicts(incident, item.attributes)) return [];
    return [dockerObservation(item.id, item.attributes)];
  }
  if (item.stored.source === 'health') {
    const a = item.attributes;
    const binding = item.event && policy.healthRules.find((rule) => rule.nodeId === incident.node_id && rule.service === incident.service
      && rule.ruleId === a?.ruleId && rule.ruleVersion === a?.ruleVersion && rule.target === a?.target
      && rule.url === a?.url && rule.method === a?.method && rule.container === a?.containerName
      && rule.failureSamples === a?.failureSamples && rule.intervalMs === a?.intervalMs);
    return [{ kind: 'health', binding: binding ? { kind: 'bound', target: binding.target, ruleId: binding.ruleId } : { kind: 'missing' }, transition: { kind: 'failure' }, source }];
  }
  return isOrdinarySignal(item.stored.type) ? [ordinary(source)] : [];
}

function ordinary(source: NotificationObservation['source']): NotificationObservation {
  return {
    kind: 'ordinary-error',
    persistence: UNKNOWN,
    impact: UNKNOWN,
    failures: UNKNOWN,
    requests: UNKNOWN,
    logLines: UNKNOWN,
    source,
  };
}

function exceptionObservation(incident: IncidentRow, event: OpsEvent): NotificationObservation | undefined {
  const raw = event.attributes;
  if (event.source === 'docker' && identityConflicts(incident, raw)) return undefined;
  const rawFatal = (event.type === 'jvm.oom' && raw.exceptionClass === 'java.lang.OutOfMemoryError')
    || (event.type === 'jvm.stack_overflow' && raw.exceptionClass === 'java.lang.StackOverflowError');
  const fields = rawFatal ? {
    exceptionClass: String(raw.exceptionClass),
    exceptionMessage: typeof raw.exceptionMessage === 'string' ? raw.exceptionMessage : '',
    stackTrace: realExceptionStack(raw.stackTrace) ?? realExceptionStack(raw.exceptionStackTrace) ?? realExceptionStack(raw.jfrStackTrace) ?? '',
  } : projectedException(incident, event);
  if (!fields || (event.source === 'docker' && !realExceptionStack(fields.stackTrace))) return undefined;
  return { kind: 'jvm-exception', ...fields, source: { kind: 'event', id: event.id } };
}

function oomeObservation(incident: IncidentRow, event: OpsEvent): NotificationObservation | undefined {
  const fields = projectedException(incident, event);
  if (!fields || !['java.lang.OutOfMemoryError', 'java.lang.StackOverflowError'].includes(fields.exceptionClass)) return undefined;
  if (fields.exceptionMessage.trim().length === 0 && fields.stackTrace.trim().length === 0) return undefined;
  return { kind: 'jvm-exception', ...fields, source: { kind: 'event', id: event.id } };
}

function projectedException(
  incident: IncidentRow,
  event: OpsEvent,
): { exceptionClass: string; exceptionMessage: string; stackTrace: string } | undefined {
  const projected = projectJfrSignalEvidence({ id: incident.id, node_id: incident.node_id }, event);
  if (!projected || !isRecord(projected.data)) return undefined;
  const attributes = projected.data.attributes;
  if (!isRecord(attributes)) return undefined;
  const exceptionClass = attributes.exceptionClass;
  if (typeof exceptionClass !== 'string' || exceptionClass.length === 0) return undefined;
  const exceptionMessage = typeof attributes.exceptionMessage === 'string' ? attributes.exceptionMessage : '';
  const primary = typeof attributes.stackTrace === 'string' ? attributes.stackTrace : '';
  const extended = realExceptionStack(attributes.jfrStackTrace) ?? realExceptionStack(attributes.exceptionStackTrace) ?? '';
  return { exceptionClass, exceptionMessage, stackTrace: primary || extended };
}

function dockerObservation(id: string, attributes: Record<string, unknown>): NotificationObservation {
  const exitCode = attributes.exitCode;
  return {
    kind: 'docker',
    dockerAction: typeof attributes.dockerAction === 'string' ? attributes.dockerAction : '',
    oomKilled: attributes.oomKilled === true,
    exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode)
      ? { kind: 'known', value: exitCode }
      : { kind: 'absent' },
    source: { kind: 'event', id },
  };
}

function metadataConflicts(incident: IncidentRow, attributes: Record<string, unknown>): boolean {
  return conflicts(attributes.containerName, incident.service)
    || identityConflicts(incident, attributes);
}

/**
 * A fault read from container logs carries the service the container runs, and
 * the container name says nothing about that identity (ADR-0031). The event's
 * own service and node must still agree with the Incident; the container name
 * stays available for evidence collection.
 */
function identityConflicts(incident: IncidentRow, attributes: Record<string, unknown>): boolean {
  return conflicts(attributes.service, incident.service)
    || conflicts(attributes.nodeId, incident.node_id);
}

function conflicts(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.length > 0 && value !== expected;
}

const DOCKER_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\s+/;

function expectedLogRule(
  policy: NotificationPolicyConfig,
  service: string,
  message: string,
  attributes: Record<string, unknown> | undefined,
): { ruleId: string } | undefined {
  const code = attributes?.businessCode;
  if (code !== 'LOG_ERROR' && code !== 'UNHANDLED_EXCEPTION') return undefined;
  const exceptionMessage = typeof attributes?.exceptionMessage === 'string' ? attributes.exceptionMessage : '';
  return serviceNotificationPolicy(policy, service).expectedLogErrors?.find((rule) =>
    message.includes(rule.contains) || exceptionMessage.includes(rule.contains));
}

function lineBodies(text: string): string[] {
  return text.split('\n').map((line) => line.replace(DOCKER_TIME_PREFIX, ''));
}

function namedClass(value: string, name: string): boolean {
  return value === name || value.endsWith(`.${name}`);
}

function pythonFrame(stack: string): boolean {
  return lineBodies(stack).some((line) => /^\s*File\s+".*",\s+line\s+\d+/.test(line));
}

function nodeFrame(stack: string): boolean {
  return lineBodies(stack).some((line) => /^\s*at\s+\S+/.test(line));
}

function nodeHeapLine(text: string): boolean {
  return lineBodies(text).some((line) => line.startsWith('FATAL ERROR:') && line.includes('JavaScript heap out of memory'));
}

function runtimeEvidence(
  runtime: 'python' | 'node',
  fault: 'oom' | 'stack-overflow',
  exceptionClass: string,
  exceptionMessage: string,
  stackTrace: string,
  message: string,
  incomplete: boolean,
): boolean {
  if (runtime === 'python' && fault === 'oom') return namedClass(exceptionClass, 'MemoryError') && (pythonFrame(stackTrace) || incomplete);
  if (runtime === 'python' && fault === 'stack-overflow') {
    return namedClass(exceptionClass, 'RecursionError')
      && exceptionMessage.includes('maximum recursion depth exceeded')
      && (pythonFrame(stackTrace) || incomplete);
  }
  if (runtime === 'node' && fault === 'oom') return nodeHeapLine(stackTrace) || nodeHeapLine(message);
  return namedClass(exceptionClass, 'RangeError')
    && exceptionMessage.includes('Maximum call stack size exceeded')
    && (nodeFrame(stackTrace) || incomplete);
}

function runtimeFatalObservation(incident: IncidentRow, event: OpsEvent): NotificationObservation | undefined {
  if (event.source === 'docker' && identityConflicts(incident, event.attributes)) return undefined;
  const runtime = event.attributes.runtime;
  if (runtime !== 'python' && runtime !== 'node') return undefined;
  const fault = event.type === 'runtime.oom' ? 'oom' : event.type === 'runtime.stack_overflow' ? 'stack-overflow' : undefined;
  if (!fault) return undefined;
  const exceptionClass = typeof event.attributes.exceptionClass === 'string' ? event.attributes.exceptionClass : '';
  const exceptionMessage = typeof event.attributes.exceptionMessage === 'string' ? event.attributes.exceptionMessage : '';
  const stackTrace = typeof event.attributes.stackTrace === 'string' ? event.attributes.stackTrace : '';
  const incomplete = event.attributes.stackIncomplete === true;
  if (!runtimeEvidence(runtime, fault, exceptionClass, exceptionMessage, stackTrace, event.message, incomplete)) return undefined;
  return {
    kind: 'runtime-fatal',
    runtime,
    fault,
    exceptionClass,
    exceptionMessage,
    stackTrace,
    ...(incomplete ? { stackIncomplete: true } : {}),
    source: { kind: 'event', id: event.id },
  };
}

function realExceptionStack(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/(?:^|\n)\s*at\s+\S+\([^)\n]*\)/.test(value)) return undefined;
  return value;
}

function parsedTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function compareId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseAttributes(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toOpsEvent(stored: StoredEvent, attributes: Record<string, unknown>): OpsEvent | undefined {
  const parsed = validateOpsEvent({
    schemaVersion: stored.schema_version,
    id: stored.id,
    time: stored.event_time,
    source: stored.source,
    nodeId: stored.node_id,
    service: stored.service,
    type: stored.type,
    severity: stored.severity,
    message: stored.message,
    attributes,
    ...(stored.fingerprint !== null ? { fingerprint: stored.fingerprint } : {}),
    ...(stored.trace_id !== null ? { traceId: stored.trace_id } : {}),
  });
  return parsed.success ? parsed.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
