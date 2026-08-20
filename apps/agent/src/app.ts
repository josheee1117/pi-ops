import { Hono } from 'hono';
import type { AgentConfig } from './config.js';
import type { EventStore } from './store.js';
import { validateEventBatch } from '@pi-ops/protocol';

export function createApp(config: AgentConfig, store: EventStore): Hono {
  const app = new Hono();

  // Logger is configured to not log the Authorization header value.
  // We use a custom logger that redacts the token.
  app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    // Token value is never printed.
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

    // Persist (idempotent via INSERT OR IGNORE)
    const receiveTime = new Date().toISOString();
    const inserted = store.insertBatch(batch, receiveTime);

    return c.json({
      accepted: batch.events.length,
      rejected: 0,
    });
  });

  return app;
}