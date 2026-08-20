import { Hono } from 'hono';
import type { AgentConfig } from './config.js';
import { DuplicateEventConflictError, type EventStore } from './store.js';
import type { IncidentEngine } from './incident.js';
import type { EvidenceJobWorker } from './evidence-worker.js';
import { validateEventBatch } from '@pi-ops/protocol';

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
): Hono {
  const app = new Hono();

  // Logger — token value is never printed.
  app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    console.log(`[agent] ${method} ${path} → ${status} (${duration}ms)`);
  });

  // ── GET /health ──────────────────────────────────────────────────────────

  app.get('/health', (c) => {
    return c.json({ status: 'ok', nodeId: config.nodeId });
  });

  // ── POST /v1/events ──────────────────────────────────────────────────────

  app.post('/v1/events', async (c) => {
    // Auth
    const auth = c.req.header('Authorization');
    const expected = `Bearer ${config.ingestToken}`;
    if (!auth || auth !== expected) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Parse with a streaming cap. Content-Length is only an early rejection;
    // the byte counter remains authoritative for chunked/false headers.
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

    // Persist immutable Events, Incident updates/links, and newly scheduled
    // evidence jobs in one transaction. The request is accepted only after the
    // complete synchronous state transition commits.
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

    // Node Agent I/O stays asynchronous and never blocks event ingestion.
    if (createdIncidents > 0) evidenceWorker?.wake();

    return c.json({
      accepted: batch.events.length,
      rejected: 0,
    });
  });

  return app;
}