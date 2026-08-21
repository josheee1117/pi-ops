import {
  validateEvidence,
  type Evidence,
  type EvidenceQueryRequest,
  type OpsEvent,
} from '@pi-ops/protocol';
import type { AgentConfig, NodeAgentEndpoint } from './config.js';
import type { EventStore, IncidentRow } from './store.js';

export interface EvidenceCollectionSummary {
  incidentId: string;
  requested: number;
  succeeded: number;
  failed: number;
  retryableFailures: number;
  terminalFailures: number;
}

export interface EvidenceOrchestrator {
  collectForIncident(
    incident: IncidentRow,
    triggeringEvent: OpsEvent,
    collectionId?: string,
  ): Promise<EvidenceCollectionSummary>;
}

export type FetchLike = typeof fetch;

class ResponseTooLargeError extends Error {}

class PersistenceFailure extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'PersistenceFailure';
  }
}

function stringAttribute(event: OpsEvent, key: string): string | undefined {
  const value = event.attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Bounded lookback/lookahead around Incident/Event time for docker.logs. */
export const EVIDENCE_LOG_LOOKBACK_MS = 2 * 60 * 1000;

/** Absolute docker.logs window anchored at the triggering Event time. */
export function evidenceLogWindow(eventTime: string): { since: string; until: string } {
  const timestamp = new Date(eventTime).getTime();
  return {
    since: new Date(timestamp - EVIDENCE_LOG_LOOKBACK_MS).toISOString(),
    until: new Date(timestamp + EVIDENCE_LOG_LOOKBACK_MS).toISOString(),
  };
}

function dockerLogsQuery(
  incidentId: string,
  container: string,
  eventTime: string,
  maxLines: number,
): EvidenceQueryRequest {
  const { since, until } = evidenceLogWindow(eventTime);
  return {
    type: 'docker.logs',
    incidentId,
    container,
    since,
    until,
    maxLines,
  };
}

/**
 * Deterministically map an Incident to bounded, typed evidence requests.
 * No model or prompt participates in this decision.
 */
export function planEvidenceQueries(
  incident: IncidentRow,
  triggeringEvent: OpsEvent,
  logsMaxLines: number,
): EvidenceQueryRequest[] {
  const configuredContainer = stringAttribute(triggeringEvent, 'containerName');
  const container = configuredContainer ?? incident.service;

  switch (incident.type) {
    case 'container.oom':
      return [
        { type: 'docker.inspect', incidentId: incident.id, container },
        { type: 'docker.stats', incidentId: incident.id, container },
        dockerLogsQuery(incident.id, container, triggeringEvent.time, logsMaxLines),
        { type: 'host.memory', incidentId: incident.id },
      ];

    case 'container.die':
      return [
        { type: 'docker.inspect', incidentId: incident.id, container },
        dockerLogsQuery(incident.id, container, triggeringEvent.time, logsMaxLines),
      ];

    case 'jvm.cpu_pressure': {
      const queries: EvidenceQueryRequest[] = [];
      if (configuredContainer) {
        queries.push({ type: 'docker.stats', incidentId: incident.id, container: configuredContainer });
      }
      queries.push({ type: 'host.load', incidentId: incident.id });
      return queries;
    }

    case 'jvm.gc_pressure': {
      const queries: EvidenceQueryRequest[] = [];
      if (configuredContainer) {
        queries.push({ type: 'docker.stats', incidentId: incident.id, container: configuredContainer });
      }
      queries.push({ type: 'host.memory', incidentId: incident.id });
      return queries;
    }

    case 'application.slow_sql': {
      const queries: EvidenceQueryRequest[] = [];
      if (configuredContainer) {
        queries.push(
          { type: 'docker.inspect', incidentId: incident.id, container: configuredContainer },
          { type: 'docker.stats', incidentId: incident.id, container: configuredContainer },
        );
      }
      queries.push({ type: 'host.load', incidentId: incident.id });
      return queries;
    }

    case 'business.error': {
      if (!configuredContainer) return [];
      return [
        { type: 'docker.inspect', incidentId: incident.id, container: configuredContainer },
        dockerLogsQuery(incident.id, configuredContainer, triggeringEvent.time, logsMaxLines),
      ];
    }

    case 'health.failure': {
      const queries: EvidenceQueryRequest[] = [];
      const isConfiguredHttpDetector = triggeringEvent.source === 'health'
        && stringAttribute(triggeringEvent, 'detector') === 'http.health';
      const url = stringAttribute(triggeringEvent, 'url');
      if (isConfiguredHttpDetector && url) {
        queries.push({
          type: 'http.probe',
          incidentId: incident.id,
          url,
          method: stringAttribute(triggeringEvent, 'method') ?? 'GET',
        });
      }

      const mappedContainer = stringAttribute(triggeringEvent, 'containerName');
      if (mappedContainer) {
        queries.push(
          { type: 'docker.inspect', incidentId: incident.id, container: mappedContainer },
          dockerLogsQuery(incident.id, mappedContainer, triggeringEvent.time, logsMaxLines),
        );
      }
      return queries;
    }

    default:
      return [];
  }
}

function querySource(type: EvidenceQueryRequest['type']): string {
  if (type.startsWith('docker.')) return 'docker';
  if (type.startsWith('host.')) return 'host';
  return 'health';
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(`Node-agent response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[REDACTED]') : message;
}

type CollectionOutcome = 'succeeded' | 'retryable-failure' | 'terminal-failure';

class CollectionFailure extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'CollectionFailure';
  }
}

function retryableFailure(message: string): CollectionFailure {
  return new CollectionFailure(message, true);
}

function terminalFailure(message: string): CollectionFailure {
  return new CollectionFailure(message, false);
}

function failureEvidence(
  incident: IncidentRow,
  query: EvidenceQueryRequest,
  id: string,
): Evidence {
  return {
    id,
    incidentId: incident.id,
    nodeId: incident.node_id,
    source: querySource(query.type),
    kind: query.type,
    collectedAt: new Date().toISOString(),
    data: null,
  };
}

export function createEvidenceOrchestrator(
  config: AgentConfig,
  store: EventStore,
  fetchImpl: FetchLike = fetch,
): EvidenceOrchestrator {
  async function collectOne(
    endpoint: NodeAgentEndpoint | undefined,
    incident: IncidentRow,
    query: EvidenceQueryRequest,
    evidenceId: string,
  ): Promise<CollectionOutcome> {
    if (!endpoint) {
      const evidence = failureEvidence(incident, query, evidenceId);
      store.insertEvidence({
        ...evidence,
        status: 'failed',
        error: `No node-agent configured for node ${incident.node_id}`,
        failureClass: 'terminal',
      });
      return 'terminal-failure';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.evidenceTimeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchImpl(`${endpoint.url}/v1/evidence/query`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${endpoint.token}`,
          },
          body: JSON.stringify(query),
          signal: controller.signal,
        });
      } catch (error) {
        const message = controller.signal.aborted
          ? `Node-agent request timed out after ${config.evidenceTimeoutMs}ms`
          : `Node-agent connection failed: ${error instanceof Error ? error.message : String(error)}`;
        throw retryableFailure(message);
      }

      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => {});
        throw retryableFailure(`Node-agent returned HTTP ${response.status}`);
      }
      const declaredHeader = response.headers.get('content-length');
      if (declaredHeader !== null) {
        const declaredLength = Number(declaredHeader);
        if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
          await response.body?.cancel().catch(() => {});
          throw terminalFailure('Node-agent returned invalid Content-Length');
        }
        if (declaredLength > config.evidenceMaxResponseBytes) {
          await response.body?.cancel().catch(() => {});
          throw terminalFailure(
            `Node-agent response exceeds ${config.evidenceMaxResponseBytes} bytes`,
          );
        }
      }

      let text: string;
      try {
        text = await readBoundedBody(response, config.evidenceMaxResponseBytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.ok) {
          throw terminalFailure(
            `Node-agent returned HTTP ${response.status}; response stream failed: ${message}`,
          );
        }
        if (controller.signal.aborted) {
          throw retryableFailure(
            `Node-agent request timed out after ${config.evidenceTimeoutMs}ms`,
          );
        }
        if (error instanceof ResponseTooLargeError) throw terminalFailure(message);
        throw retryableFailure(`Node-agent response stream failed: ${message}`);
      }
      if (!response.ok) {
        throw terminalFailure(
          `Node-agent returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw terminalFailure('Node-agent returned invalid JSON');
      }

      const validation = validateEvidence(body);
      if (!validation.success) {
        throw terminalFailure(`Invalid Evidence response: ${validation.message}`);
      }

      const evidence = validation.value;
      if (evidence.incidentId !== incident.id) {
        throw terminalFailure('Evidence incidentId does not match the requested Incident');
      }
      if (evidence.nodeId !== incident.node_id) {
        throw terminalFailure('Evidence nodeId does not match the Incident node');
      }
      if (evidence.kind !== query.type) {
        throw terminalFailure('Evidence kind does not match the requested query type');
      }
      if (evidence.source !== querySource(query.type)) {
        throw terminalFailure('Evidence source does not match the requested query type');
      }

      try {
        store.insertEvidence({
          ...evidence,
          id: evidenceId,
          status: 'succeeded',
        });
      } catch (error) {
        throw new PersistenceFailure(error);
      }
      return 'succeeded';
    } catch (error) {
      if (error instanceof PersistenceFailure) throw error.original;
      const failure = error instanceof CollectionFailure
        ? error
        : terminalFailure(error instanceof Error ? error.message : String(error));
      const message = redactSecret(failure.message, endpoint.token);
      const evidence = failureEvidence(incident, query, evidenceId);
      store.insertEvidence({
        ...evidence,
        status: 'failed',
        error: message,
        failureClass: failure.retryable ? 'retryable' : 'terminal',
      });
      return failure.retryable ? 'retryable-failure' : 'terminal-failure';
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    async collectForIncident(
      incident: IncidentRow,
      triggeringEvent: OpsEvent,
      collectionId?: string,
    ): Promise<EvidenceCollectionSummary> {
      const queries = planEvidenceQueries(
        incident,
        triggeringEvent,
        config.evidenceLogsMaxLines,
      );
      const evidenceBaseId = collectionId ?? `incident-${incident.id}`;
      const existingEvidence = new Map(
        store.listEvidence(incident.id).map((item) => [item.id, item]),
      );
      let planningFailures = 0;
      const expectsHttpProbe = incident.type === 'health.failure'
        && triggeringEvent.source === 'health'
        && stringAttribute(triggeringEvent, 'detector') === 'http.health';
      if (
        expectsHttpProbe &&
        !queries.some((query) => query.type === 'http.probe')
      ) {
        const query: EvidenceQueryRequest = {
          type: 'http.probe',
          incidentId: incident.id,
        };
        const evidenceId = `${evidenceBaseId}-evidence-http.probe`;
        if (!existingEvidence.has(evidenceId)) {
          const evidence = failureEvidence(incident, query, evidenceId);
          store.insertEvidence({
            ...evidence,
            status: 'failed',
            error: 'Cannot plan http.probe: triggering event has no URL',
            failureClass: 'terminal',
          });
        }
        planningFailures++;
      }

      const endpoint = config.nodeAgents.get(incident.node_id);
      const settled = await Promise.allSettled(
        queries.map((query) => {
          const evidenceId = `${evidenceBaseId}-evidence-${query.type}`;
          const existing = existingEvidence.get(evidenceId);
          if (existing?.status === 'succeeded') return Promise.resolve('succeeded' as const);
          if (existing?.failureClass === 'terminal') {
            return Promise.resolve('terminal-failure' as const);
          }
          return collectOne(endpoint, incident, query, evidenceId);
        }),
      );
      const results: CollectionOutcome[] = [];
      let hasRejection = false;
      let firstRejection: unknown;
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else if (!hasRejection) {
          hasRejection = true;
          firstRejection = result.reason;
        }
      }
      if (hasRejection) throw firstRejection;
      const succeeded = results.filter((result) => result === 'succeeded').length;
      const retryableFailures = results.filter(
        (result) => result === 'retryable-failure',
      ).length;
      const terminalFailures = results.filter(
        (result) => result === 'terminal-failure',
      ).length + planningFailures;
      const requested = queries.length + planningFailures;
      return {
        incidentId: incident.id,
        requested,
        succeeded,
        failed: retryableFailures + terminalFailures,
        retryableFailures,
        terminalFailures,
      };
    },
  };
}
