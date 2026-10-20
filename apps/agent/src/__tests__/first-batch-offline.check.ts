/**
 * Opt-in offline contract snapshot for B01, B02, and S06.
 * The agent test script loads only files named *.test.ts, so this file stays out of that run.
 * Exit 0 means the in-memory contract still matches this file. It is not a scenario PASS.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBatch, OpsEvent } from '@pi-ops/protocol';
import { validateEventBatch } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import type { AgentConfig } from '../config.js';
import { planEvidenceQueries } from '../evidence-orchestrator.js';
import { RECOVERY_TYPE_MAP } from '../fingerprint.js';
import { createIncidentEngine, type IncidentEngine } from '../incident.js';
import { createNotificationJobWorker, type NotificationJobWorker } from '../notification-worker.js';
import { notificationJobId } from '../notification.js';
import { createFakeNotifier } from '../notifier.js';
import { createEventStore, type EventStore } from '../store.js';
import { makeAgentConfig } from './test-config.js';

const DRAFT_POLICY_APPROVED = false;
const LIVE_DATAASSET_CALLED = false;

type ScenarioId = 'B01' | 'B02' | 'S06';
type Verdict = 'PASS' | 'FAIL' | 'GAP' | 'BLOCKED' | 'NOT_RUN';
type Phase = 'discovery' | 'evidence' | 'diagnosis' | 'notification' | 'recovery';

interface PhaseResult {
  verdict: Verdict;
  because: string;
}

interface ScenarioReport {
  id: ScenarioId;
  realBinding: 'missing';
  acceptedExpectation: string;
  draftExpectation: string;
  observed: string[];
  phases: Record<Phase, PhaseResult>;
  policy: 'BLOCKED';
}

interface OfflineReport {
  kind: 'offline-contract-snapshot';
  scenarioPass: false;
  exitMeaning: string;
  draftPolicyApproved: false;
  liveDataAssetCalled: false;
  mismatches: string[];
  scenarios: ScenarioReport[];
}

const mismatches: string[] = [];

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) {
    mismatches.push(`${label}: observed ${JSON.stringify(actual)}, contract ${JSON.stringify(expected)}`);
  }
}

function expectDeepEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    mismatches.push(`${label}: observed ${JSON.stringify(actual)}, contract ${JSON.stringify(expected)}`);
  }
}

function phase(verdict: Verdict, because: string): PhaseResult {
  if (verdict === 'PASS') {
    mismatches.push(`offline snapshot must not emit scenario PASS: ${because}`);
    return { verdict: 'FAIL', because: 'snapshot tried to emit PASS' };
  }
  return { verdict, because };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function readBody(response: Response): Promise<unknown> {
  return response.json();
}

function isCountBody(value: unknown): value is { accepted: number; rejected: number } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('accepted' in value) || !('rejected' in value)) return false;
  return typeof value.accepted === 'number' && typeof value.rejected === 'number';
}

function stringAttr(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function at(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function batch(events: OpsEvent[], producerType: EventBatch['producer']['type']): EventBatch {
  return {
    producer: { id: 'first-batch-offline', type: producerType, version: '0' },
    events,
  };
}

function requireBatch(raw: unknown, label: string): EventBatch {
  const validation = validateEventBatch(raw);
  if (!validation.success) {
    mismatches.push(`${label}: ${validation.message}`);
    throw new Error(`${label} failed validation`);
  }
  return validation.value;
}

interface Session {
  store: EventStore;
  engine: IncidentEngine;
  app: ReturnType<typeof createApp>;
  notifier: ReturnType<typeof createFakeNotifier>;
  worker: NotificationJobWorker;
}

function openSession(config: AgentConfig): Session {
  const store = createEventStore(':memory:');
  const engine = createIncidentEngine(store, {
    aggregationWindowMs: config.aggregationWindowMs,
    scheduleLocalReasoning: false,
  });
  const notifier = createFakeNotifier();
  const worker = createNotificationJobWorker(config, store, notifier);
  const app = createApp(config, store, engine, undefined, undefined, undefined, worker);
  return { store, engine, app, notifier, worker };
}

async function post(session: Session, body: EventBatch, token: string): Promise<{ status: number; accepted: number; rejected: number }> {
  const response = await session.app.request('/v1/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const parsed = await readBody(response);
  if (!isCountBody(parsed)) {
    mismatches.push(`ingress body was not an accepted/rejected count: ${JSON.stringify(parsed)}`);
    return { status: response.status, accepted: -1, rejected: -1 };
  }
  await session.worker.runOnce();
  return { status: response.status, accepted: parsed.accepted, rejected: parsed.rejected };
}

function jobTypes(store: EventStore, incidentId: string): string[] {
  return store.listNotificationJobs(incidentId).map((job) => job.type);
}

function queryTypes(store: EventStore, incidentId: string, logsMaxLines: number): string[] {
  const incident = store.getIncident(incidentId);
  const job = store.getEvidenceJob(`job-${incidentId}`);
  if (!incident || !job) return [];
  return planEvidenceQueries(incident, job.triggeringEvent, logsMaxLines).map((query) => query.type);
}

async function main(): Promise<OfflineReport> {
  if (DRAFT_POLICY_APPROVED) {
    mismatches.push('DRAFT_POLICY_APPROVED must stay false until the owner approves the draft and this snapshot is rewritten');
  }
  if (LIVE_DATAASSET_CALLED) {
    mismatches.push('this file must not call DataAsset');
  }

  const config = makeAgentConfig({
    ingestToken: 'first-batch-offline-token',
    aggregationWindowMs: 5 * 60 * 1000,
    evidenceJobPollIntervalMs: 60_000,
    reasoningJobPollIntervalMs: 60_000,
    notificationJobPollIntervalMs: 60_000,
  });
  const token = config.ingestToken;
  const windowMs = config.aggregationWindowMs;

  const empty = createEventStore(':memory:');
  expectEqual(empty.count(), 0, 'empty event count');
  expectEqual(empty.incidentCount(), 0, 'empty incident count');
  expectEqual(empty.evidenceCount(), 0, 'empty evidence count');
  expectEqual(empty.pendingRecoveryCount(), 0, 'empty pending recovery count');
  empty.close();

  const b01 = openSession(config);
  const b01Event: OpsEvent = {
    schemaVersion: 1,
    id: 'first-batch-b01-rejection-shaped',
    time: '2026-08-20T12:00:00.000Z',
    source: 'application',
    nodeId: 'first-batch-offline-node',
    service: 'first-batch-offline',
    type: 'business.error',
    severity: 'error',
    traceId: 'first-batch-b01',
    message: 'synthetic rejection-shaped event, not a DataAsset send',
    attributes: { businessCode: 'INVALID_PARAMETER', module: 'dict' },
  };
  const b01Post = await post(b01, requireBatch(batch([b01Event], 'application'), 'B01 synthetic'), token);
  const b01Incidents = b01.store.listIncidents();
  const b01Incident = b01Incidents[0];
  expectEqual(b01Post.status, 200, 'B01 ingress status');
  expectEqual(b01Post.accepted, 1, 'B01 accepted count');
  expectEqual(b01.store.count(), 1, 'B01 event count');
  expectEqual(b01.store.incidentCount(), 1, 'B01 incident count');
  expectEqual(b01Incident?.state, 'OPEN', 'B01 incident state');
  expectEqual(b01Incident?.type, 'business.error', 'B01 incident type');
  expectDeepEqual(b01Incident ? jobTypes(b01.store, b01Incident.id) : [], ['INCIDENT_OPEN'], 'B01 notification jobs');
  expectEqual(b01.store.evidenceCount(), 0, 'B01 evidence records');
  expectDeepEqual(b01Incident ? queryTypes(b01.store, b01Incident.id, config.evidenceLogsMaxLines) : ['missing'], [], 'B01 evidence plan');
  expectEqual(b01.notifier.sent.length, 1, 'B01 fake deliveries');
  expectEqual(b01.notifier.sent[0]?.type, 'INCIDENT_OPEN', 'B01 fake delivery type');
  const b01Jobs = b01Incident ? jobTypes(b01.store, b01Incident.id) : [];
  const b01Observed = [
    `synthetic ingress status ${b01Post.status}, accepted ${b01Post.accepted}`,
    `events ${b01.store.count()}, incidents ${b01.store.incidentCount()}, state ${b01Incident?.state ?? 'none'}, type ${b01Incident?.type ?? 'none'}`,
    `notification jobs ${b01Incident ? jobTypes(b01.store, b01Incident.id).join(',') : 'none'}`,
    `evidence records ${b01.store.evidenceCount()}, plan ${JSON.stringify(b01Incident ? queryTypes(b01.store, b01Incident.id, config.evidenceLogsMaxLines) : [])}`,
    'no DataAsset sender call and no expected-rejection filter in this process',
  ];
  b01.store.close();

  const fixture = requireBatch(
    readJson(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dataasset-business-error.eventbatch.json')),
    'B02 golden fixture',
  );
  const golden = fixture.events[0];
  if (!golden) throw new Error('B02 golden fixture has no event');
  const businessCode = stringAttr(golden.attributes, 'businessCode');
  const moduleName = stringAttr(golden.attributes, 'module');
  if (!businessCode || !moduleName) throw new Error('B02 golden fixture lacks businessCode or module');
  expectEqual(stringAttr(golden.attributes, 'exceptionClass'), undefined, 'B02 golden exceptionClass');
  const goldenMs = Date.parse(golden.time);
  if (!Number.isFinite(goldenMs)) throw new Error('B02 golden time is not parseable');

  const b02 = openSession(config);
  const firstPost = await post(b02, fixture, token);
  const insideOffsetMs = 60_000;
  const outsideOffsetMs = insideOffsetMs + windowMs + 1000;
  const second: OpsEvent = {
    ...golden,
    id: 'first-batch-b02-same-point-60s',
    time: at(goldenMs, insideOffsetMs),
    message: 'same code and module inside the aggregation window',
  };
  await post(b02, requireBatch(batch([second], 'application'), 'B02 repeat'), token);
  const third: OpsEvent = {
    ...golden,
    id: 'first-batch-b02-same-point-outside-window',
    time: at(goldenMs, outsideOffsetMs),
    message: 'same code and module outside the aggregation window',
  };
  await post(b02, requireBatch(batch([third], 'application'), 'B02 sparse'), token);
  const inventedType = 'business.error_recovered';
  expectEqual(RECOVERY_TYPE_MAP[inventedType], undefined, 'business.error recovery mapping');
  expectEqual(
    Object.values(RECOVERY_TYPE_MAP).includes('business.error'),
    false,
    'recovery map target business.error',
  );
  const invented: OpsEvent = {
    ...golden,
    id: 'first-batch-b02-invented-recovery',
    time: at(goldenMs, outsideOffsetMs + 60_000),
    type: inventedType,
    severity: 'info',
    message: 'invented recovery type, not an accepted contract',
  };
  await post(b02, requireBatch(batch([invented], 'application'), 'B02 invented recovery'), token);
  const b02Ids = b02.store.listIncidents().map((incident) => incident.id);
  const firstIncident = b02.store.findIncidentByEventId(golden.id);
  const secondIncident = b02.store.findIncidentByEventId(second.id);
  const thirdIncident = b02.store.findIncidentByEventId(third.id);
  const inventedIncident = b02.store.findIncidentByEventId(invented.id);
  expectEqual(firstPost.status, 200, 'B02 golden status');
  expectEqual(firstIncident?.id, secondIncident?.id, 'B02 window aggregation');
  expectEqual(firstIncident?.event_count, 2, 'B02 aggregated event count');
  expectEqual(thirdIncident?.id === firstIncident?.id, false, 'B02 outside-window split');
  expectEqual(b02.store.incidentCount(), 3, 'B02 incident count');
  expectEqual(inventedIncident?.state, 'OPEN', 'B02 invented recovery state');
  expectEqual(inventedIncident?.type, inventedType, 'B02 invented recovery type');
  expectEqual(b02.store.pendingRecoveryCount(), 0, 'B02 pending recovery count');
  expectEqual(
    b02Ids.filter((id) => b02.store.getIncident(id)?.state === 'RECOVERED').length,
    0,
    'B02 recovered incidents',
  );
  expectDeepEqual(
    firstIncident ? queryTypes(b02.store, firstIncident.id, config.evidenceLogsMaxLines) : [],
    ['docker.inspect', 'docker.logs'],
    'B02 golden evidence plan',
  );
  expectEqual(b02.store.evidenceCount(), 0, 'B02 evidence records');
  const b02OpenJobs = b02Ids.reduce((sum, id) => sum + jobTypes(b02.store, id).filter((type) => type === 'INCIDENT_OPEN').length, 0);
  expectEqual(b02OpenJobs, 3, 'B02 OPEN jobs');
  const b02Observed = [
    `golden fixture ${golden.id} ingress ${firstPost.status}`,
    `window ${windowMs}ms from last_seen, same incident at +${insideOffsetMs}ms, new incident at +${outsideOffsetMs}ms`,
    `incidents ${b02.store.incidentCount()}, recovered ${b02Ids.filter((id) => b02.store.getIncident(id)?.state === 'RECOVERED').length}, pending recoveries ${b02.store.pendingRecoveryCount()}`,
    `recovery map keys ${Object.keys(RECOVERY_TYPE_MAP).join(',')}`,
    `evidence records ${b02.store.evidenceCount()}, first plan ${JSON.stringify(firstIncident ? queryTypes(b02.store, firstIncident.id, config.evidenceLogsMaxLines) : [])}`,
    'fixture containerName and nodeId were not rewritten',
    'golden attributes have no exceptionClass',
  ];
  b02.store.close();

  const s06 = openSession(config);
  const s06Base = Date.parse('2026-08-20T13:00:00.000Z');
  function healthEvent(id: string, offsetMs: number, type: 'health.failure' | 'health.recovered', status: number): OpsEvent {
    return {
      schemaVersion: 1,
      id,
      time: at(s06Base, offsetMs),
      source: 'health',
      nodeId: 'first-batch-offline-node',
      service: 'first-batch-offline',
      type,
      severity: type === 'health.failure' ? 'error' : 'info',
      message: `synthetic ${type}, not a live probe`,
      attributes: {
        detector: 'http.health',
        target: 'first-batch-offline',
        url: 'http://first-batch-offline.invalid/actuator/health',
        method: 'GET',
        containerName: 'first-batch-offline-container',
        status,
      },
    };
  }
  const failureIds = ['s06-fail-1', 's06-fail-2', 's06-fail-3'];
  for (let index = 0; index < failureIds.length; index += 1) {
    const id = failureIds[index];
    if (!id) continue;
    await post(s06, requireBatch(batch([healthEvent(id, index * 10_000, 'health.failure', 503)], 'node-agent'), id), token);
  }
  const recovery = healthEvent('s06-recovered', 30_000, 'health.recovered', 200);
  await post(s06, requireBatch(batch([recovery], 'node-agent'), 's06 recovery'), token);
  await post(s06, requireBatch(batch([recovery], 'node-agent'), 's06 recovery replay'), token);
  const s06Incident = s06.store.findIncidentByEventId('s06-fail-1');
  expectEqual(s06.store.incidentCount(), 1, 'S06 single-episode incidents');
  expectEqual(s06Incident?.state, 'RECOVERED', 'S06 single-episode state');
  expectEqual(s06Incident?.event_count, 4, 'S06 single-episode event count');
  expectDeepEqual(
    s06Incident ? jobTypes(s06.store, s06Incident.id) : [],
    ['INCIDENT_OPEN', 'INCIDENT_RECOVERED'],
    'S06 single-episode jobs',
  );
  expectEqual(s06.store.getEvidenceJob(s06Incident ? `job-${s06Incident.id}` : '')?.state, 'PENDING', 'S06 evidence job state');
  expectEqual(s06.store.evidenceCount(), 0, 'S06 evidence records');
  expectDeepEqual(
    s06Incident ? queryTypes(s06.store, s06Incident.id, config.evidenceLogsMaxLines) : [],
    ['http.probe', 'docker.inspect', 'docker.logs'],
    'S06 evidence plan',
  );
  expectDeepEqual(s06.notifier.sent.map((item) => item.type), ['INCIDENT_OPEN', 'INCIDENT_RECOVERED'], 'S06 fake delivery order');
  expectEqual(s06Incident ? s06.store.getNotificationJob(notificationJobId('INCIDENT_OPEN', s06Incident.id))?.status : undefined, 'DELIVERED', 'S06 OPEN status');
  expectEqual(s06Incident ? s06.store.getNotificationJob(notificationJobId('INCIDENT_RECOVERED', s06Incident.id))?.status : undefined, 'DELIVERED', 'S06 RECOVERED status');
  const s06Observed = [
    `single episode incidents ${s06.store.incidentCount()}, state ${s06Incident?.state ?? 'none'}, events ${s06Incident?.event_count ?? 0}`,
    `jobs ${s06Incident ? jobTypes(s06.store, s06Incident.id).join(',') : 'none'}`,
    `fake notifier ${s06.notifier.sent.map((item) => item.type).join(',')}`,
    `evidence records ${s06.store.evidenceCount()}, job ${s06.store.getEvidenceJob(s06Incident ? `job-${s06Incident.id}` : '')?.state ?? 'none'}`,
    `plan ${JSON.stringify(s06Incident ? queryTypes(s06.store, s06Incident.id, config.evidenceLogsMaxLines) : [])}`,
    'probe URL was not fetched',
  ];
  s06.store.close();

  const quiet = openSession(config);
  const quietOffsetMs = windowMs + 60_000;
  await post(quiet, requireBatch(batch([healthEvent('s06-quiet-fail', 0, 'health.failure', 503)], 'node-agent'), 'quiet fail'), token);
  await post(
    quiet,
    requireBatch(batch([healthEvent('s06-quiet-recovered', quietOffsetMs, 'health.recovered', 200)], 'node-agent'), 'quiet recovery'),
    token,
  );
  const quietIncident = quiet.store.findIncidentByEventId('s06-quiet-fail');
  const quietRecoveryIncident = quiet.store.findIncidentByEventId('s06-quiet-recovered');
  expectEqual(quiet.store.incidentCount(), 1, 'S06 quiet long episode incidents');
  expectEqual(quietIncident?.id, quietRecoveryIncident?.id, 'S06 quiet long episode same incident');
  expectEqual(quietIncident?.state, 'RECOVERED', 'S06 quiet long episode state');
  expectEqual(quietIncident?.event_count, 2, 'S06 quiet long episode event count');
  expectDeepEqual(
    quietIncident ? jobTypes(quiet.store, quietIncident.id) : [],
    ['INCIDENT_OPEN', 'INCIDENT_RECOVERED'],
    'S06 quiet long episode jobs',
  );
  expectEqual(quiet.store.pendingRecoveryCount(), 0, 'S06 quiet long episode pending recoveries');
  const quietObserved = [
    `one synthetic health.failure then one health.recovered ${quietOffsetMs}ms later, with no extra failure`,
    `incidents ${quiet.store.incidentCount()}, state ${quietIncident?.state ?? 'none'}, events ${quietIncident?.event_count ?? 0}`,
    `jobs ${quietIncident ? jobTypes(quiet.store, quietIncident.id).join(',') : 'none'}`,
    `pending recoveries ${quiet.store.pendingRecoveryCount()}`,
    'synthetic event timestamps are not a measured fault duration',
  ];
  quiet.store.close();

  const split = openSession(config);
  await post(split, requireBatch(batch([healthEvent('s06-split-1', 0, 'health.failure', 503)], 'node-agent'), 'split 1'), token);
  await post(
    split,
    requireBatch(batch([healthEvent('s06-split-2', windowMs + 60_000, 'health.failure', 503)], 'node-agent'), 'split 2'),
    token,
  );
  await post(
    split,
    requireBatch(batch([healthEvent('s06-split-recovery', windowMs + 120_000, 'health.recovered', 200)], 'node-agent'), 'split recovery'),
    token,
  );
  split.engine.reconcilePendingRecoveries();
  const splitStates = split.store.listIncidents().map((incident) => incident.state);
  expectEqual(split.store.incidentCount(), 2, 'S06 split incidents');
  expectDeepEqual(splitStates, ['OPEN', 'OPEN'], 'S06 split states');
  expectEqual(split.store.pendingRecoveryCount(), 1, 'S06 split pending recoveries');
  expectEqual(
    split.store.listIncidents().reduce((sum, incident) => sum + jobTypes(split.store, incident.id).filter((type) => type === 'INCIDENT_RECOVERED').length, 0),
    0,
    'S06 split RECOVERED jobs',
  );
  const splitObserved = [
    `synthetic input only: two health.failure events separated by ${windowMs + 60_000}ms, not a detector trace`,
    `incidents ${split.store.incidentCount()} states ${splitStates.join(',')}`,
    `pending recoveries after reconcile ${split.store.pendingRecoveryCount()}`,
    'no RECOVERED job was written',
    'real trigger for a second failure event was not measured',
  ];
  split.store.close();

  const scenarios: ScenarioReport[] = [
    {
      id: 'B01',
      realBinding: 'missing',
      acceptedExpectation: 'ADR-0027 schedules one INCIDENT_OPEN for each new Incident. No expected-rejection filter exists.',
      draftExpectation: 'An expected business rejection keeps a record and sends no fault alert. No RECOVERED message is sent when no fault Incident exists.',
      observed: b01Observed,
      policy: 'BLOCKED',
      phases: {
        discovery: phase('BLOCKED', 'This process did not call DataAsset. Real binding is missing.'),
        evidence: phase('NOT_RUN', 'No live request or response was collected.'),
        diagnosis: phase('NOT_RUN', 'No model call was made.'),
        notification: phase(
          b01Jobs.length === 1 && b01Jobs[0] === 'INCIDENT_OPEN' ? 'BLOCKED' : 'FAIL',
          'The synthetic event scheduled INCIDENT_OPEN. The draft that would suppress that alert is not approved.',
        ),
        recovery: phase('BLOCKED', 'The live success control was not run. The synthetic event had no recovery type and did not write INCIDENT_RECOVERED.'),
      },
    },
    {
      id: 'B02',
      realBinding: 'missing',
      acceptedExpectation: 'A received business.error opens an Incident. Recovery requires a mapped recovery type. business.error has none.',
      draftExpectation: 'One ordinary ERROR is recorded. Continued failure of the same throw point updates the original Incident and does not repeat the first alert. Recovery needs a successful retry through the declared window.',
      observed: b02Observed,
      policy: 'BLOCKED',
      phases: {
        discovery: phase('NOT_RUN', 'This process ingested the golden fixture only. It did not run DataAsset or measure the Starter.'),
        evidence: phase('NOT_RUN', 'The stored golden event plans docker.inspect and docker.logs. Evidence records stayed 0, and the fixture has no exceptionClass.'),

        diagnosis: phase('NOT_RUN', 'No model call was made.'),
        notification: phase('BLOCKED', 'Each new Incident scheduled INCIDENT_OPEN, including the outside-window repeat. Alert counts are not scored against the draft.'),
        recovery: phase('GAP', 'RECOVERY_TYPE_MAP has no business.error target. The invented type opened another OPEN Incident.'),
      },
    },
    {
      id: 'S06',
      realBinding: 'missing',
      acceptedExpectation: 'health.failure and health.recovered are mapped. One active candidate recovers. Multiple active candidates fail closed.',
      draftExpectation: 'Continued 503 alerts once, does not open another Incident, and sends one recovery message after continued success.',
      observed: [...s06Observed, ...quietObserved, ...splitObserved],
      policy: 'BLOCKED',
      phases: {
        discovery: phase('BLOCKED', 'This process did not probe a DataAsset target.'),

        evidence: phase('NOT_RUN', 'The evidence job stayed PENDING. The invalid probe URL was not fetched.'),
        diagnosis: phase('NOT_RUN', 'No model call was made.'),
        notification: phase('BLOCKED', 'FakeNotifier delivered OPEN then RECOVERED for one synthetic episode. That is not an approved alert count and not a WeCom delivery.'),
        recovery: phase('BLOCKED', 'One synthetic failure recovered after a timestamp gap wider than the aggregation window. Two synthetic failures beyond that window left recovery pending. Neither gap is a measured fault duration, and the live target was not failed or restored.'),
      },
    },
  ];

  for (const scenario of scenarios) {
    for (const [name, result] of Object.entries(scenario.phases)) {
      if (result.verdict === 'PASS') mismatches.push(`${scenario.id} ${name} emitted PASS`);
    }
    if (scenario.policy !== 'BLOCKED') mismatches.push(`${scenario.id} policy was not BLOCKED`);
    if (scenario.realBinding !== 'missing') mismatches.push(`${scenario.id} real binding was marked present`);
  }

  return {
    kind: 'offline-contract-snapshot',
    scenarioPass: false,
    exitMeaning: 'Exit 0 means this in-memory contract snapshot still matches. It is not a B01, B02, or S06 scenario PASS.',
    draftPolicyApproved: DRAFT_POLICY_APPROVED,
    liveDataAssetCalled: LIVE_DATAASSET_CALLED,
    mismatches,
    scenarios,
  };
}

const report = await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  mismatches.push(message);
  const failed: OfflineReport = {
    kind: 'offline-contract-snapshot',
    scenarioPass: false,
    exitMeaning: 'Exit 0 means this in-memory contract snapshot still matches. It is not a B01, B02, or S06 scenario PASS.',
    draftPolicyApproved: false,
    liveDataAssetCalled: false,
    mismatches,
    scenarios: [],
  };
  return failed;
});

console.log(`FIRST_BATCH_OFFLINE_REPORT mismatches=${report.mismatches.length}`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.mismatches.length === 0 ? 0 : 1);
