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
}

export interface EvidenceOrchestrator {
  collectForIncident(
    incident: IncidentRow,
    triggeringEvent: OpsEvent,
    collectionId?: string,
  ): Promise<EvidenceCollectionSummary>;
}

export type FetchLike = typeof fetch;

function stringAttribute(event: OpsEvent, key: string): string | undefined {
  const value = event.attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
  const container = stringAttribute(triggeringEvent, 'containerName') ?? incident.service;

  switch (incident.type) {
    case 'container.oom':
      return [
        { type: 'docker.inspect', incidentId: incident.id, container },
        { type: 'docker.stats', incidentId: incident.id, container },
        {
          type: 'docker.logs',
          incidentId: incident.id,
          container,
          since: '2m',
          maxLines: logsMaxLines,
        },
        { type: 'host.memory', incidentId: incident.id },
      ];

    case 'container.die':
      return [
        { type: 'docker.inspect', incidentId: incident.id, container },
        {
          type: 'docker.logs',
          incidentId: incident.id,
          container,
          since: '2m',
          maxLines: logsMaxLines,
        },
      ];

    case 'health.failure': {
      const queries: EvidenceQueryRequest[] = [];
      const url = stringAttribute(triggeringEvent, 'url');
      if (url) {
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
          {
            type: 'docker.logs',
            incidentId: incident.id,
            container: mappedContainer,
            since: '2m',
            maxLines: logsMaxLines,
          },
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
      await reader.cancel();
      throw new Error(`Node-agent response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('[REDACTED]') : message;
}

function failureEvidence(
  incident: IncidentRow,
  query: EvidenceQueryRequest,
  id?: string,
): Evidence {
  return {
    id: id ?? `evd-failed-${crypto.randomUUID()}`,
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
    evidenceId?: string,
  ): Promise<boolean> {
    if (!endpoint) {
      const evidence = failureEvidence(incident, query, evidenceId);
      store.insertEvidence({
        ...evidence,
        status: 'failed',
        error: `No node-agent configured for node ${incident.node_id}`,
      });
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.evidenceTimeoutMs);

    try {
      const response = await fetchImpl(`${endpoint.url}/v1/evidence/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${endpoint.token}`,
        },
        body: JSON.stringify(query),
        signal: controller.signal,
      });

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > config.evidenceMaxResponseBytes) {
        throw new Error(
          `Node-agent response exceeds ${config.evidenceMaxResponseBytes} bytes`,
        );
      }

      const text = await readBoundedBody(
        response,
        config.evidenceMaxResponseBytes,
      );
      if (!response.ok) {
        throw new Error(`Node-agent returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error('Node-agent returned invalid JSON');
      }

      const validation = validateEvidence(body);
      if (!validation.success) {
        throw new Error(`Invalid Evidence response: ${validation.message}`);
      }

      const evidence = validation.value;
      if (evidence.incidentId !== incident.id) {
        throw new Error('Evidence incidentId does not match the requested Incident');
      }
      if (evidence.nodeId !== incident.node_id) {
        throw new Error('Evidence nodeId does not match the Incident node');
      }
      if (evidence.kind !== query.type) {
        throw new Error('Evidence kind does not match the requested query type');
      }
      if (evidence.source !== querySource(query.type)) {
        throw new Error('Evidence source does not match the requested query type');
      }

      store.insertEvidence({
        ...evidence,
        ...(evidenceId ? { id: evidenceId } : {}),
        status: 'succeeded',
      });
      return true;
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = redactSecret(rawMessage, endpoint.token);
      const evidence = failureEvidence(incident, query, evidenceId);
      store.insertEvidence({ ...evidence, status: 'failed', error: message });
      return false;
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
      let planningFailures = 0;
      if (
        incident.type === 'health.failure' &&
        !queries.some((query) => query.type === 'http.probe')
      ) {
        const query: EvidenceQueryRequest = {
          type: 'http.probe',
          incidentId: incident.id,
        };
        const evidence = failureEvidence(
          incident,
          query,
          collectionId ? `${collectionId}-evidence-0` : undefined,
        );
        store.insertEvidence({
          ...evidence,
          status: 'failed',
          error: 'Cannot plan http.probe: triggering event has no URL',
        });
        planningFailures++;
      }

      const endpoint = config.nodeAgents.get(incident.node_id);
      const results = await Promise.all(
        queries.map((query, index) => collectOne(
          endpoint,
          incident,
          query,
          collectionId
            ? `${collectionId}-evidence-${index + planningFailures}`
            : undefined,
        )),
      );
      const succeeded = results.filter(Boolean).length;
      const requested = queries.length + planningFailures;
      return {
        incidentId: incident.id,
        requested,
        succeeded,
        failed: requested - succeeded,
      };
    },
  };
}
