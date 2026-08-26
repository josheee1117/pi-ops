import { Hono } from 'hono';
import {
  INVESTIGATION_RUNTIME_SCHEMA_VERSION,
  validateInvestigationSubmitRequest,
  validateRuntimeInvestigationContext,
  type InvestigationRuntimeMetadata,
  type InvestigationRuntimeResult,
  type RuntimeInvestigationContext,
} from '@pi-ops/protocol';
import { investigate, type CoordinatorOptions } from './coordinator.js';
import { createRuntimeTaskStore, type RuntimeTaskStore } from './tasks.js';
import { postRuntimeResult } from './callback.js';
import type { PiRuntimeConfig } from './config.js';

class RequestBodyTooLargeError extends Error {}

export interface PiRuntimeApp {
  app: Hono;
  tasks: RuntimeTaskStore;
  drain(): Promise<void>;
}

export function createPiRuntimeApp(
  config: PiRuntimeConfig,
  options: {
    fetch?: typeof fetch;
    coordinator?: CoordinatorOptions;
    now?: () => string;
  } = {},
): PiRuntimeApp {
  const tasks = createRuntimeTaskStore();
  const pending = new Set<Promise<void>>();
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', (c) => c.json({ status: 'ready' }));

  app.post('/v1/investigations', async (c) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${config.token}`) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let body: unknown;
    try {
      body = await readJsonBody(c.req.raw, config.maxBodySize);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ error: 'payload too large' }, 413);
      }
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parsed = validateInvestigationSubmitRequest(body);
    if (!parsed.success) return c.json({ error: parsed.message }, 400);
    const request = parsed.value;
    const context = validateRuntimeInvestigationContext(request.context);
    if (!context.success) return c.json({ error: context.message }, 400);

    const created = tasks.create({
      runtimeRequestId: request.runtimeRequestId,
      sessionId: request.sessionId,
      incidentId: request.incidentId,
      now: now(),
    });
    if (!created.duplicate) {
      enqueue(() => runTask(created.task.runtimeRequestId, request.callbackUrl, context.value));
    }
    return c.json({
      schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
      runtimeRequestId: created.task.runtimeRequestId,
      runtimeTaskId: created.task.runtimeTaskId,
      duplicate: created.duplicate,
    });
  });

  async function runTask(
    runtimeRequestId: string,
    callbackUrl: string,
    context: RuntimeInvestigationContext,
  ): Promise<void> {
    const task = tasks.getByRequestId(runtimeRequestId);
    if (!task || task.status === 'completed' || task.status === 'failed') return;
    tasks.update(runtimeRequestId, { status: 'running' });
    const outcome = investigate(context, {
      ...options.coordinator,
      maxContextBytes: config.maxContextBytes,
    });
    const metadata: InvestigationRuntimeMetadata = {
      runtimeRequestId: task.runtimeRequestId,
      runtimeTaskId: task.runtimeTaskId,
      selectedSpecialists: outcome.selectedSpecialists,
      specialistStatus: outcome.specialistStatus,
      latencyMs: outcome.latencyMs,
      provider: 'fake',
      model: 'deterministic',
      reportStatus: outcome.status,
      ...(outcome.historicalKnowledgeStatus
        ? { historicalKnowledgeStatus: outcome.historicalKnowledgeStatus }
        : {}),
    };
    const result: InvestigationRuntimeResult = {
      schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
      runtimeRequestId: task.runtimeRequestId,
      runtimeTaskId: task.runtimeTaskId,
      sessionId: task.sessionId,
      status: outcome.status,
      ...(outcome.report ? { report: outcome.report } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      metadata,
    };
    tasks.update(runtimeRequestId, {
      status: outcome.status,
      metadata,
      result,
    });
    await postRuntimeResult(callbackUrl, config.token, result, fetchImpl, config.timeoutMs);
  }

  function enqueue(work: () => Promise<void>): void {
    const job = new Promise<void>((resolve) => {
      setTimeout(() => {
        work().then(resolve, (error) => {
          console.error('[pi-runtime] investigation failed', error instanceof Error ? error.message : error);
          resolve();
        });
      }, 0);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }

  return {
    app,
    tasks,
    drain: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
}

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
