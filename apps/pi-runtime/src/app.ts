import { Hono } from 'hono';
import {
  INVESTIGATION_RUNTIME_SCHEMA_VERSION,
  validateInvestigationSubmitRequest,
  validateRuntimeInvestigationContext,
  type InvestigationRuntimeMetadata,
  type InvestigationRuntimeResult,
  type RuntimeInvestigationContext,
} from '@pi-ops/protocol';
import { postRuntimeResult } from './callback.js';
import { callbackUrlAllowed, type PiRuntimeConfig } from './config.js';
import { investigate, type CoordinatorOptions } from './coordinator.js';
import { ExecutionTimeoutError } from './deadline.js';
import type { RuntimeEvidenceClient } from './evidence-client.js';
import { createFakeRuntimeModel, type RuntimeModel } from './model.js';
import { createRuntimeTaskStore, type RuntimeTaskRecord, type RuntimeTaskStore } from './store.js';

class RequestBodyTooLargeError extends Error {}

export interface PiRuntimeApp {
  app: Hono;
  tasks: RuntimeTaskStore;
  drain(): Promise<void>;
  close(): void;
}

export function createPiRuntimeApp(
  config: PiRuntimeConfig,
  options: {
    fetch?: typeof fetch;
    model?: RuntimeModel;
    coordinator?: CoordinatorOptions;
    evidenceClient?: RuntimeEvidenceClient;
    now?: () => string;
  } = {},
): PiRuntimeApp {
  const tasks = createRuntimeTaskStore(config.sqlitePath);
  const pending = new Set<Promise<void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const fetchImpl = options.fetch ?? fetch;
  const model = options.model ?? createFakeRuntimeModel();
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
    if (!callbackUrlAllowed(request.callbackUrl, config.callbackBaseUrl)) {
      return c.json({ error: 'callback url is not allowed' }, 400);
    }
    const context = validateRuntimeInvestigationContext(request.context);
    if (!context.success) return c.json({ error: context.message }, 400);

    const created = tasks.create({
      runtimeRequestId: request.runtimeRequestId,
      sessionId: request.sessionId,
      incidentId: request.incidentId,
      contextJson: JSON.stringify(context.value),
      now: now(),
    });
    if (!created.duplicate) {
      enqueue(() => executeTask(created.task.runtimeRequestId));
    } else if (needsDelivery(created.task, config.maxDeliveryAttempts)) {
      enqueue(() => deliverTask(created.task.runtimeRequestId));
    }
    return c.json({
      schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
      runtimeRequestId: created.task.runtimeRequestId,
      runtimeTaskId: created.task.runtimeTaskId,
      duplicate: created.duplicate,
    });
  });

  function recover(): void {
    for (const task of tasks.listResumable(config.maxDeliveryAttempts)) {
      if (task.executionStatus === 'queued' || task.executionStatus === 'running') {
        enqueue(() => executeTask(task.runtimeRequestId));
      } else {
        if (task.deliveryStatus === 'delivering') {
          tasks.update(task.runtimeRequestId, { deliveryStatus: 'pending' });
        }
        enqueue(() => deliverTask(task.runtimeRequestId));
      }
    }
  }

  async function executeTask(runtimeRequestId: string): Promise<void> {
    const task = tasks.getByRequestId(runtimeRequestId);
    if (!task) return;
    if (task.executionStatus === 'completed' || task.executionStatus === 'failed') {
      await deliverTask(runtimeRequestId);
      return;
    }
    tasks.update(runtimeRequestId, {
      executionStatus: 'running',
      startedAt: now(),
    });
    const context = JSON.parse(task.contextJson) as RuntimeInvestigationContext;
    let outcome;
    try {
      outcome = await investigate(context, {
        ...options.coordinator,
        model,
        maxContextBytes: config.maxContextBytes,
        executionTimeoutMs: config.executionTimeoutMs,
        evidenceClient: options.evidenceClient,
        runtimeRequestId: task.runtimeRequestId,
        runtimeTaskId: task.runtimeTaskId,
        sessionId: task.sessionId,
      });
    } catch (error) {
      const timedOut = error instanceof ExecutionTimeoutError || (error instanceof Error && error.message === 'execution timeout');
      outcome = {
        status: 'failed' as const,
        error: timedOut ? 'execution timeout' : error instanceof Error ? error.message : String(error),
        selectedSpecialists: [],
        findings: [],
        specialistStatus: {},
        latencyMs: 0,
        provider: model.provider,
        model: model.model,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
    const current = tasks.getByRequestId(runtimeRequestId);
    if (current && (current.executionStatus === 'completed' || current.executionStatus === 'failed') && current.result) {
      return;
    }
    const metadata: InvestigationRuntimeMetadata = {
      runtimeRequestId: task.runtimeRequestId,
      runtimeTaskId: task.runtimeTaskId,
      selectedSpecialists: outcome.selectedSpecialists,
      specialistStatus: outcome.specialistStatus,
      latencyMs: outcome.latencyMs,
      provider: outcome.provider,
      model: outcome.model,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
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
      executionStatus: outcome.status,
      deliveryStatus: 'pending',
      completedAt: now(),
      metadata,
      result,
      lastError: outcome.error,
    });
    await deliverTask(runtimeRequestId);
  }

  async function deliverTask(runtimeRequestId: string): Promise<void> {
    const task = tasks.getByRequestId(runtimeRequestId);
    if (!task?.result) return;
    if (task.deliveryStatus === 'delivered') return;
    if (task.deliveryAttempts >= config.maxDeliveryAttempts) {
      tasks.update(runtimeRequestId, { deliveryStatus: 'failed' });
      return;
    }
    tasks.update(runtimeRequestId, { deliveryStatus: 'delivering' });
    try {
      await postRuntimeResult(
        config.callbackBaseUrl,
        config.token,
        task.result,
        fetchImpl,
        config.callbackTimeoutMs,
      );
      const latest = tasks.getByRequestId(runtimeRequestId);
      if (latest?.executionStatus === 'failed' && latest.result?.status === 'failed' && task.result.status === 'completed') {
        return;
      }
      tasks.update(runtimeRequestId, { deliveryStatus: 'delivered', lastError: undefined });
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      const deliveryAttempts = task.deliveryAttempts + 1;
      const deliveryStatus = deliveryAttempts >= config.maxDeliveryAttempts ? 'failed' : 'pending';
      tasks.update(runtimeRequestId, { deliveryStatus, lastError, deliveryAttempts });
      if (deliveryStatus === 'pending') {
        enqueue(() => deliverTask(runtimeRequestId), config.deliveryBackoffMs * deliveryAttempts);
      }
    }
  }

  function enqueue(work: () => Promise<void>, delayMs = 0): void {
    const job = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        work().then(resolve, (error) => {
          console.error('[pi-runtime] background work failed', error instanceof Error ? error.message : error);
          resolve();
        });
      }, delayMs);
      timers.add(timer);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }

  recover();

  return {
    app,
    tasks,
    drain: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      tasks.close();
    },
  };
}

function needsDelivery(task: RuntimeTaskRecord, maxAttempts: number): boolean {
  return (task.executionStatus === 'completed' || task.executionStatus === 'failed')
    && task.deliveryStatus !== 'delivered'
    && task.deliveryAttempts < maxAttempts;
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
