import { Hono } from 'hono';
import type { AgentConfig } from './config.js';
import type { EventStore } from './store.js';
import type { IncidentEngine } from './incident.js';
import type { EvidenceOrchestrator } from './evidence-orchestrator.js';
import { validateEventBatch } from '@pi-ops/protocol';

export function createApp(
  config: AgentConfig,
  store: EventStore,
  incidentEngine: IncidentEngine,
  evidenceOrchestrator?: EvidenceOrchestrator,
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

    // Body size check
    const contentLength = parseInt(c.req.header('Content-Length') ?? '0', 10);
    if (contentLength > config.maxBodySize) {
      return c.json(
        { error: 'payload too large', maxBytes: config.maxBodySize },
        413,
      );
    }

    // Parse + validate
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
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

    // Persist events (idempotent via INSERT OR IGNORE)
    const receiveTime = new Date().toISOString();
    store.insertBatch(batch, receiveTime);

    // Process each event through the incident engine.
    // Evidence collection starts only for a newly created Incident and runs
    // asynchronously so a slow/unavailable node agent cannot block ingestion.
    for (const event of batch.events) {
      const incidentResult = incidentEngine.processEvent(event, event.time);
      if (incidentResult.isNew && evidenceOrchestrator) {
        const incident = store.getIncident(incidentResult.incidentId);
        if (incident) {
          void evidenceOrchestrator.collectForIncident(incident, event).catch((err) => {
            console.error(
              `[agent] evidence orchestration failed for ${incident.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      }
    }

    return c.json({
      accepted: batch.events.length,
      rejected: 0,
    });
  });

  return app;
}