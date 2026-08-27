export const NOTIFICATION_SCHEMA_VERSION = 1 as const;

export const NOTIFICATION_TYPES = [
  'INCIDENT_OPEN',
  'INVESTIGATION_COMPLETED',
  'INCIDENT_RECOVERED',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_JOB_STATUSES = [
  'PENDING',
  'RUNNING',
  'DELIVERED',
  'FAILED',
] as const;

export type NotificationJobStatus = (typeof NOTIFICATION_JOB_STATUSES)[number];

export interface NotificationIncidentFacts {
  id: string;
  service: string;
  nodeId: string;
  severity: string;
  state: string;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
}

export interface NotificationAnalysis {
  investigationSessionId: string;
  reasoningResultId: string;
  hypothesis: string;
  confidence: number;
  recommendation: string;
}

export interface NotificationPayload {
  schemaVersion: typeof NOTIFICATION_SCHEMA_VERSION;
  type: NotificationType;
  incident: Omit<NotificationIncidentFacts, 'eventCount'>;
  facts: {
    eventCount: number;
    evidenceIds: string[];
  };
  analysis?: NotificationAnalysis;
}

export interface NotificationJob {
  id: string;
  type: NotificationType;
  incidentId: string;
  investigationSessionId?: string;
  reasoningResultId?: string;
  status: NotificationJobStatus;
  attempts: number;
  payload: NotificationPayload;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

export function notificationJobId(type: NotificationType, key: string): string {
  if (type === 'INCIDENT_OPEN') return `njob-open-${key}`;
  if (type === 'INVESTIGATION_COMPLETED') return `njob-completed-${key}`;
  return `njob-recovered-${key}`;
}

export function buildNotificationPayload(input: {
  type: NotificationType;
  incident: NotificationIncidentFacts;
  evidenceIds: readonly string[];
  analysis?: NotificationAnalysis;
}): NotificationPayload {
  const payload: NotificationPayload = {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    type: input.type,
    incident: {
      id: input.incident.id,
      service: input.incident.service,
      nodeId: input.incident.nodeId,
      severity: input.incident.severity,
      state: input.incident.state,
      firstSeen: input.incident.firstSeen,
      lastSeen: input.incident.lastSeen,
    },
    facts: {
      eventCount: input.incident.eventCount,
      evidenceIds: [...input.evidenceIds].sort((left, right) => left.localeCompare(right)),
    },
  };
  if (input.type === 'INVESTIGATION_COMPLETED' && input.analysis) {
    payload.analysis = input.analysis;
  }
  return payload;
}

export function incidentFactsFromRow(incident: {
  id: string;
  service: string;
  node_id: string;
  severity: string;
  state: string;
  first_seen: string;
  last_seen: string;
  event_count: number;
}): NotificationIncidentFacts {
  return {
    id: incident.id,
    service: incident.service,
    nodeId: incident.node_id,
    severity: incident.severity,
    state: incident.state,
    firstSeen: incident.first_seen,
    lastSeen: incident.last_seen,
    eventCount: incident.event_count,
  };
}

export function buildNotificationJob(input: {
  type: NotificationType;
  incident: NotificationIncidentFacts;
  evidenceIds: readonly string[];
  now: string;
  investigationSessionId?: string;
  reasoningResultId?: string;
  analysis?: NotificationAnalysis;
}): NotificationJob {
  const key = input.type === 'INVESTIGATION_COMPLETED'
    ? input.investigationSessionId ?? input.incident.id
    : input.incident.id;
  return {
    id: notificationJobId(input.type, key),
    type: input.type,
    incidentId: input.incident.id,
    ...(input.investigationSessionId ? { investigationSessionId: input.investigationSessionId } : {}),
    ...(input.reasoningResultId ? { reasoningResultId: input.reasoningResultId } : {}),
    status: 'PENDING',
    attempts: 0,
    payload: buildNotificationPayload(input),
    createdAt: input.now,
    updatedAt: input.now,
  };
}
