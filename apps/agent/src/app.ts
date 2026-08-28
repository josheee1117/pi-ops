import { Hono } from 'hono';
import type { AgentConfig } from './config.js';
import { DuplicateEventConflictError, type EventStore } from './store.js';
import type { IncidentEngine } from './incident.js';
import type { EvidenceJobWorker } from './evidence-worker.js';
import {
  validateEventBatch,
  validateInvestigationRuntimeResult,
  validateRuntimeEvidenceRequestBatch,
} from '@pi-ops/protocol';
import type { createInvestigationLoopService } from './investigation-loop.js';
import type { createInvestigationEvidenceService } from './investigation-evidence.js';
import type { NotificationJobWorker } from './notification-worker.js';
import {
  MODEL_SAFE_MAX_LOG_LINES,
  toRuntimeSafeEvidence,
} from './incident-context.js';

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) throw new RequestBodyTooLargeError();
  if (!request.body) throw new SyntaxError('missing request body');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
  return JSON.parse(text) as unknown;
}

export function createApp(
  config: AgentConfig,
  store: EventStore,
  incidentEngine: IncidentEngine,
  evidenceWorker?: EvidenceJobWorker,
  investigationLoop?: ReturnType<typeof createInvestigationLoopService>,
  investigationEvidence?: ReturnType<typeof createInvestigationEvidenceService>,
  notificationWorker?: NotificationJobWorker,
): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    console.log(`[agent] ${method} ${path} → ${status} (${duration}ms)`);
  });

  app.get('/health', (c) => {
    return c.json({ status: 'ok', nodeId: config.nodeId });
  });

  app.post('/v1/events', async (c) => {
    const auth = c.req.header('Authorization');
    const expected = `Bearer ${config.ingestToken}`;
    if (!auth || auth !== expected) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, config.maxBodySize);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return c.json(
          { accepted: 0, rejected: 0, error: 'payload too large', maxBytes: config.maxBodySize },
          413,
        );
      }
      return c.json({ accepted: 0, rejected: 0, error: 'invalid JSON' }, 400);
    }

    const validation = validateEventBatch(body);
    if (!validation.success) {
      return c.json({
        accepted: 0,
        rejected: 0,
        error: `validation failed: ${validation.message}`,
      }, 400);
    }

    const batch = validation.value;
    const receiveTime = new Date().toISOString();
    let createdIncidents = 0;
    try {
      const result = store.processBatch(
        batch,
        receiveTime,
        (event) => incidentEngine.processEvent(event, event.time),
      );
      createdIncidents = result.createdIncidents;
    } catch (error) {
      if (error instanceof DuplicateEventConflictError) {
        return c.json({
          accepted: 0,
          rejected: batch.events.length,
          error: 'duplicate event id conflicts with immutable payload',
          eventId: error.eventId,
        }, 409);
      }
      throw error;
    }

    if (createdIncidents > 0) evidenceWorker?.wake();
    notificationWorker?.wake();

    return c.json({
      accepted: batch.events.length,
      rejected: 0,
    });
  });

  app.post('/v1/investigation-results', async (c) => {
    if (!investigationLoop) return c.json({ error: 'investigation loop unavailable' }, 503);
    const expectedToken = config.piRuntimeToken;
    const auth = c.req.header('Authorization');
    if (!expectedToken || !auth || auth !== `Bearer ${expectedToken}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, config.maxBodySize);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return c.json({ error: 'payload too large' }, 413);
      }
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parsed = validateInvestigationRuntimeResult(body);
    if (!parsed.success) return c.json({ error: parsed.message }, 400);
    try {
      const result = investigationLoop.handleRuntimeResult(parsed.value);
      notificationWorker?.wake();
      return c.json({ ok: true, status: parsed.value.status, id: result.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });

  app.post('/v1/investigation-evidence', async (c) => {
    if (!investigationEvidence) return c.json({ error: 'investigation evidence unavailable' }, 503);
    const expectedToken = config.piRuntimeToken;
    const auth = c.req.header('Authorization');
    if (!expectedToken || !auth || auth !== `Bearer ${expectedToken}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, config.maxBodySize);
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return c.json({ error: 'payload too large' }, 413);
      }
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parsed = validateRuntimeEvidenceRequestBatch(body);
    if (!parsed.success) return c.json({ error: parsed.message }, 400);
    try {
      const result = await investigationEvidence.handle(parsed.value);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });

  app.get('/v1/ops/incidents', (c) => {
    if (!operatorAuthorized(c, config)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({
      incidents: store.listIncidents().map((incident) => ({
        id: incident.id,
        service: incident.service,
        nodeId: incident.node_id,
        type: incident.type,
        state: incident.state,
        eventCount: incident.event_count,
        firstSeen: incident.first_seen,
        lastSeen: incident.last_seen,
      })),
    });
  });

  app.get('/v1/ops/incidents/:id', (c) => {
    if (!operatorAuthorized(c, config)) return c.json({ error: 'unauthorized' }, 401);
    const incident = store.getIncident(c.req.param('id'));
    if (!incident) return c.json({ error: 'not found' }, 404);
    const sessions = store.listAllInvestigationSessions().filter((session) => session.incidentId === incident.id);
    const evidence = store.listEvidence(incident.id);
    return c.json({
      incident: {
        id: incident.id,
        service: incident.service,
        nodeId: incident.node_id,
        type: incident.type,
        state: incident.state,
        eventCount: incident.event_count,
        firstSeen: incident.first_seen,
        lastSeen: incident.last_seen,
      },
      evidence: evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        collectedAt: item.collectedAt,
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        status: session.status,
        runtimeRequestId: session.runtimeRequestId,
        reportId: store.getInvestigationReportBySessionId(session.id)?.id,
      })),
      notifications: store.listNotificationJobs(incident.id).map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        notificationId: job.payload.notificationId,
        createdAt: job.createdAt,
      })),
    });
  });

  app.get('/v1/ops/incidents/:id/evidence', (c) => {
    if (!operatorAuthorized(c, config)) return c.json({ error: 'unauthorized' }, 401);
    const incident = store.getIncident(c.req.param('id'));
    if (!incident) return c.json({ error: 'not found' }, 404);
    const view = c.req.query('view') === 'raw' ? 'raw' : 'safe';
    const rows = store.listEvidence(incident.id);
    return c.json({
      view,
      evidence: rows.map((item) => (
        view === 'raw'
          ? { id: item.id, kind: item.kind, status: item.status, collectedAt: item.collectedAt, data: item.data }
          : toRuntimeSafeEvidence(item, MODEL_SAFE_MAX_LOG_LINES)
      )),
    });
  });

  app.post('/v1/ops/investigations', async (c) => {
    if (!operatorAuthorized(c, config)) return c.json({ error: 'unauthorized' }, 401);
    if (!investigationLoop) return c.json({ error: 'investigation loop unavailable' }, 503);
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, config.maxBodySize);
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const incidentId = body && typeof body === 'object' && 'incidentId' in body
      ? String((body as { incidentId?: unknown }).incidentId ?? '')
      : '';
    if (!incidentId) return c.json({ error: 'incidentId is required' }, 400);
    try {
      const { session } = investigationLoop.start(incidentId);
      const submitted = await investigationLoop.submit(session.id);
      return c.json({
        sessionId: submitted.id,
        status: submitted.status,
        runtimeRequestId: submitted.runtimeRequestId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });

  return app;
}

function operatorAuthorized(c: { req: { header(name: string): string | undefined } }, config: AgentConfig): boolean {
  const auth = c.req.header('Authorization');
  return Boolean(auth && auth === `Bearer ${config.ingestToken}`);
}
