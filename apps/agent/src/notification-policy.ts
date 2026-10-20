import { recognizedJfrSemantic } from './jfr-evidence.js';

export type SourceRef = { kind: 'event' | 'evidence'; id: string };

export type CountFact = { kind: 'known'; value: number } | { kind: 'unknown' };

export type MissingFact =
  | 'failure-count'
  | 'request-count'
  | 'persistence'
  | 'impact'
  | 'health-binding'
  | 'critical-task-binding'
  | 'critical-task-result';

export type NotificationObservation =
  | {
      kind: 'expected-rejection' | 'short-peak';
      failures: CountFact;
      requests: CountFact;
      source: SourceRef;
    }
  | {
      kind: 'ordinary-error';
      persistence: { kind: 'known'; value: 'brief' | 'sustained' } | { kind: 'unknown' };
      impact: { kind: 'known'; value: 'none' } | { kind: 'unknown' };
      failures: CountFact;
      requests: CountFact;
      /** Log line count. Not a request total and not a failure count. */
      logLines: CountFact;
      source: SourceRef;
    }
  | {
      kind: 'jvm-exception';
      exceptionClass: string;
      exceptionMessage: string;
      stackTrace: string;
      source: SourceRef;
    }
  | {
      kind: 'docker';
      dockerAction: string;
      oomKilled: boolean;
      /** Exit code is retained and never authorizes alert, including 137. */
      exitCode: { kind: 'known'; value: number } | { kind: 'absent' };
      source: SourceRef;
    }
  | {
      kind: 'health';
      binding: { kind: 'bound'; target: string; ruleId: string } | { kind: 'missing' };
      transition: { kind: 'failure' } | { kind: 'status'; code: number } | { kind: 'recovered' };
      source: SourceRef;
    }
  | {
      kind: 'critical-task';
      result: 'failed' | 'succeeded' | 'unknown';
      binding: { kind: 'bound'; objectKey: string; ruleId: string } | { kind: 'missing' };
      source: SourceRef;
    };

export type FirstNotificationReason =
  | 'jvm-oome'
  | 'docker-oom'
  | 'health-unavailable'
  | 'critical-task-impact'
  | 'sustained-impact-unknown'
  | 'expected-rejection'
  | 'short-peak'
  | 'ordinary-without-major-fact'
  | 'exception-not-oome'
  | 'container-exit-without-oom'
  | 'health-binding-missing'
  | 'health-not-unavailable'
  | 'critical-task-binding-missing'
  | 'critical-task-result-unknown'
  | 'critical-task-succeeded'
  | 'no-observation';

export interface FirstNotificationDecision {
  action: 'record' | 'analyze' | 'alert';
  reason: FirstNotificationReason;
  missing: MissingFact[];
  failures: CountFact;
  requests: CountFact;
  sources: SourceRef[];
}

export interface FirstNotificationFacts {
  observations: NotificationObservation[];
}

const GAP_ORDER: MissingFact[] = [
  'failure-count',
  'request-count',
  'persistence',
  'impact',
  'health-binding',
  'critical-task-binding',
  'critical-task-result',
];

function explicitBinding(objectKey: string, ruleId: string): boolean {
  return objectKey.trim().length > 0 && ruleId.trim().length > 0;
}

function recognizedOome(observation: NotificationObservation): boolean {
  if (observation.kind !== 'jvm-exception') return false;
  return recognizedJfrSemantic({
    eventType: 'jvm.oom',
    semanticType: 'jvm.oom',
    attributes: {
      exceptionClass: observation.exceptionClass,
      exceptionMessage: observation.exceptionMessage,
      stackTrace: observation.stackTrace,
    },
  });
}

function dockerOom(observation: NotificationObservation): boolean {
  return observation.kind === 'docker' && (observation.dockerAction === 'oom' || observation.oomKilled);
}

function boundHealthFailure(observation: NotificationObservation): boolean {
  return observation.kind === 'health'
    && observation.binding.kind === 'bound'
    && explicitBinding(observation.binding.target, observation.binding.ruleId)
    && observation.transition.kind === 'failure';
}

function boundCriticalTask(observation: NotificationObservation): boolean {
  return observation.kind === 'critical-task'
    && observation.result === 'failed'
    && observation.binding.kind === 'bound'
    && explicitBinding(observation.binding.objectKey, observation.binding.ruleId);
}

function sustainedUnknownImpact(observation: NotificationObservation): boolean {
  return observation.kind === 'ordinary-error'
    && observation.persistence.kind === 'known'
    && observation.persistence.value === 'sustained'
    && observation.impact.kind === 'unknown';
}

function healthBindingMissing(observation: Extract<NotificationObservation, { kind: 'health' }>): boolean {
  if (observation.binding.kind === 'missing') return true;
  return !explicitBinding(observation.binding.target, observation.binding.ruleId);
}

function taskBindingMissing(observation: Extract<NotificationObservation, { kind: 'critical-task' }>): boolean {
  if (observation.binding.kind === 'missing') return true;
  return !explicitBinding(observation.binding.objectKey, observation.binding.ruleId);
}

function collectMissing(observations: NotificationObservation[]): MissingFact[] {
  const found = new Set<MissingFact>();
  for (const observation of observations) {
    switch (observation.kind) {
      case 'expected-rejection':
      case 'short-peak':
        if (observation.failures.kind === 'unknown') found.add('failure-count');
        if (observation.requests.kind === 'unknown') found.add('request-count');
        break;
      case 'ordinary-error':
        if (observation.failures.kind === 'unknown') found.add('failure-count');
        if (observation.requests.kind === 'unknown') found.add('request-count');
        if (observation.persistence.kind === 'unknown') found.add('persistence');
        if (observation.impact.kind === 'unknown') found.add('impact');
        break;
      case 'jvm-exception':
      case 'docker':
        break;
      case 'health':
        if (healthBindingMissing(observation)) found.add('health-binding');
        break;
      case 'critical-task':
        if (taskBindingMissing(observation)) found.add('critical-task-binding');
        if (observation.result === 'unknown') found.add('critical-task-result');
        break;
      default: {
        const _exhaustive: never = observation;
        return _exhaustive;
      }
    }
  }
  if (observations.some((observation) => observation.kind === 'expected-rejection' || observation.kind === 'short-peak' || observation.kind === 'ordinary-error')) {
    if (echoedCount(observations, 'failures').kind === 'unknown') found.add('failure-count');
    if (echoedCount(observations, 'requests').kind === 'unknown') found.add('request-count');
  }
  return GAP_ORDER.filter((gap) => found.has(gap));
}

function echoedCount(observations: NotificationObservation[], field: 'failures' | 'requests'): CountFact {
  const values: CountFact[] = [];
  for (const observation of observations) {
    if (observation.kind === 'expected-rejection' || observation.kind === 'short-peak' || observation.kind === 'ordinary-error') {
      values.push(observation[field]);
    }
  }
  if (values.length === 0 || values.some((value) => value.kind === 'unknown')) return { kind: 'unknown' };
  const first = values[0];
  if (!first || first.kind !== 'known') return { kind: 'unknown' };
  if (values.every((value) => value.kind === 'known' && value.value === first.value)) return first;
  return { kind: 'unknown' };
}

function recordReason(observation: NotificationObservation): FirstNotificationReason {
  switch (observation.kind) {
    case 'expected-rejection':
      return 'expected-rejection';
    case 'short-peak':
      return 'short-peak';
    case 'ordinary-error':
      return 'ordinary-without-major-fact';
    case 'jvm-exception':
      return 'exception-not-oome';
    case 'docker':
      return 'container-exit-without-oom';
    case 'health':
      return healthBindingMissing(observation) ? 'health-binding-missing' : 'health-not-unavailable';
    case 'critical-task':
      if (observation.result === 'unknown') return 'critical-task-result-unknown';
      if (observation.result === 'succeeded') return 'critical-task-succeeded';
      return 'critical-task-binding-missing';
    default: {
      const _exhaustive: never = observation;
      return _exhaustive;
    }
  }
}

/**
 * First notification decision from normalized facts.
 * Does not check source trust, Incident association, time, or delivery.
 */
export function decideFirstNotification(facts: FirstNotificationFacts): FirstNotificationDecision {
  const missing = collectMissing(facts.observations);
  const failures = echoedCount(facts.observations, 'failures');
  const requests = echoedCount(facts.observations, 'requests');
  const oome = facts.observations.find(recognizedOome);
  if (oome) {
    return { action: 'alert', reason: 'jvm-oome', missing, failures, requests, sources: [oome.source] };
  }
  const docker = facts.observations.find(dockerOom);
  if (docker) {
    return { action: 'alert', reason: 'docker-oom', missing, failures, requests, sources: [docker.source] };
  }
  const health = facts.observations.find(boundHealthFailure);
  if (health) {
    return { action: 'alert', reason: 'health-unavailable', missing, failures, requests, sources: [health.source] };
  }
  const task = facts.observations.find(boundCriticalTask);
  if (task) {
    return { action: 'alert', reason: 'critical-task-impact', missing, failures, requests, sources: [task.source] };
  }
  const sustained = facts.observations.find(sustainedUnknownImpact);
  if (sustained) {
    return { action: 'analyze', reason: 'sustained-impact-unknown', missing, failures, requests, sources: [sustained.source] };
  }
  const first = facts.observations[0];
  if (!first) {
    return { action: 'record', reason: 'no-observation', missing, failures, requests, sources: [] };
  }
  return {
    action: 'record',
    reason: recordReason(first),
    missing,
    failures,
    requests,
    sources: facts.observations.map((observation) => observation.source),
  };
}
