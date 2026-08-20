import { Hono } from 'hono';
import type { NodeAgentConfig } from './config.js';
import { validateQueryRequest, queryTypeToSource } from './evidence/types.js';
import { createDockerEvidenceProvider } from './evidence/docker.js';
import { createHostEvidenceProvider } from './evidence/host.js';
import { createProbeEvidenceProvider } from './evidence/probe.js';

export function createApp(config: NodeAgentConfig): Hono {
  const app = new Hono();

  const dockerProvider = createDockerEvidenceProvider();
  const hostProvider = createHostEvidenceProvider();
  const probeProvider = createProbeEvidenceProvider();

  // Logger — token value is never printed.
  app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    console.log(`[node-agent] ${method} ${path} → ${status} (${duration}ms)`);
  });

  // ── GET /health ──────────────────────────────────────────────────────────

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      nodeId: config.nodeId,
      allowedContainers: [...config.allowedContainers],
    });
  });

  // ── POST /v1/evidence/query ──────────────────────────────────────────────

  app.post('/v1/evidence/query', async (c) => {
    // Auth
    const auth = c.req.header('Authorization');
    const expected = `Bearer ${config.nodeToken}`;
    if (!auth || auth !== expected) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Parse body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }

    // Validate
    const validation = validateQueryRequest(body, config);
    if (!validation.valid) {
      return c.json({ error: 'validation failed', details: validation.errors }, 400);
    }

    const request = validation.request;

    // Route to provider
    try {
      let result;
      if (request.type.startsWith('docker.')) {
        result = await dockerProvider.query(request, config);
      } else if (request.type.startsWith('host.')) {
        result = await hostProvider.query(request, config);
      } else if (request.type === 'http.probe') {
        result = await probeProvider.query(request, config);
      } else {
        return c.json({ error: `Unsupported query type: ${request.type}` }, 400);
      }

      // Enforce response size cap
      const json = JSON.stringify(result);
      if (Buffer.byteLength(json) > config.maxResponseBytes) {
        return c.json({
          error: 'response too large',
          maxBytes: config.maxResponseBytes,
          actualBytes: Buffer.byteLength(json),
        }, 413);
      }

      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[node-agent] evidence query failed: ${message}`);
      return c.json({ error: 'evidence collection failed', message }, 500);
    }
  });

  return app;
}