import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createEventStore } from './store.js';
import { createIncidentEngine } from './incident.js';
import { createEvidenceOrchestrator } from './evidence-orchestrator.js';
import { createEvidenceJobWorker } from './evidence-worker.js';
import { createFakeReasoner, createReasonerRegistry, type Reasoner } from './reasoner.js';
import { createPiReasoner, PI_REASONER_VERSION } from './pi-reasoner.js';
import { createPiSdkClient } from './pi-sdk-client.js';
import { createMemoryRetriever } from './memory-retriever.js';
import { createHttpPiRuntimeClient } from './http-pi-runtime-client.js';
import { createInvestigationEvidenceService } from './investigation-evidence.js';
import { createInvestigationLoopService } from './investigation-loop.js';
import { createInvestigationReconciler } from './investigation-reconciler.js';
import { createNoopPiRuntimeClient } from './pi-runtime-client.js';
import { createReasoningJobWorker } from './reasoning-worker.js';
import { createNotificationJobWorker } from './notification-worker.js';
import { createHttpWebhookNotifier } from './notifier.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = createEventStore(config.sqlitePath);
const incidentEngine = createIncidentEngine(store, {
  aggregationWindowMs: config.aggregationWindowMs,
  reasonerType: config.reasonerType,
  reasonerVersion: config.reasonerType === 'pi' ? PI_REASONER_VERSION : '1',
  scheduleLocalReasoning: !config.piRuntimeUrl,
});
let replayedEvents = 0;
while (true) {
  const replayed = store.replayPendingEvents(
    (event) => incidentEngine.processEvent(event, event.time),
    new Date().toISOString(),
    config.eventReplayBatchSize,
  );
  replayedEvents += replayed;
  if (replayed < config.eventReplayBatchSize) break;
}
if (replayedEvents > 0) {
  console.log(`[pi-ops-agent] replayed ${replayedEvents} pending Event(s)`);
}
incidentEngine.reconcilePendingRecoveries();
const evidenceOrchestrator = createEvidenceOrchestrator(config, store);
const runtimeClient = config.piRuntimeUrl && config.piRuntimeToken && config.piRuntimeCallbackUrl
  ? createHttpPiRuntimeClient({
    baseUrl: config.piRuntimeUrl,
    token: config.piRuntimeToken,
    callbackUrl: config.piRuntimeCallbackUrl,
    timeoutMs: config.piRuntimeTimeoutMs,
  })
  : createNoopPiRuntimeClient();
const investigationLoop = createInvestigationLoopService(store, { runtime: runtimeClient });
const investigationEvidence = createInvestigationEvidenceService(store, config, evidenceOrchestrator);
const investigationReconciler = createInvestigationReconciler({
  store,
  loop: investigationLoop,
  enabled: Boolean(config.piRuntimeUrl),
  maxAttempts: config.investigationRetryMaxAttempts,
  backoffMs: config.investigationRetryBackoffMs,
  pollIntervalMs: config.evidenceJobPollIntervalMs,
});
const evidenceWorker = createEvidenceJobWorker(config, store, evidenceOrchestrator, {
  onCompleted: () => {
    void investigationReconciler.reconcile();
  },
});
evidenceWorker.start();
investigationReconciler.start();
const reasoners: Reasoner[] = [createFakeReasoner()];
if (config.reasonerType === 'pi') {
  reasoners.push(createPiReasoner({
    config,
    client: await createPiSdkClient(config),
  }));
}
const reasoningWorker = createReasoningJobWorker(
  config,
  store,
  createReasonerRegistry(reasoners),
  undefined,
  createMemoryRetriever(store),
  runtimeClient,
);
reasoningWorker.start();
const notificationWorker = config.notificationWebhookUrl
  ? createNotificationJobWorker(
    config,
    store,
    createHttpWebhookNotifier({
      url: config.notificationWebhookUrl,
      timeoutMs: config.notificationTimeoutMs ?? 3000,
      maxResponseBytes: config.notificationMaxResponseBytes ?? 8192,
      ...(config.notificationWebhookToken ? { token: config.notificationWebhookToken } : {}),
    }),
  )
  : undefined;
notificationWorker?.start();
const app = createApp(
  config,
  store,
  incidentEngine,
  evidenceWorker,
  investigationLoop,
  investigationEvidence,
  notificationWorker,
);

console.log(`[pi-ops-agent] starting on :${config.port}, db=${config.sqlitePath}`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`[pi-ops-agent] listening on :${config.port}`);
