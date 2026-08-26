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
import { createNoopPiRuntimeClient } from './pi-runtime-client.js';
import { createReasoningJobWorker } from './reasoning-worker.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = createEventStore(config.sqlitePath);
const incidentEngine = createIncidentEngine(store, {
  aggregationWindowMs: config.aggregationWindowMs,
  reasonerType: config.reasonerType,
  reasonerVersion: config.reasonerType === 'pi' ? PI_REASONER_VERSION : '1',
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
const evidenceWorker = createEvidenceJobWorker(config, store, evidenceOrchestrator);
evidenceWorker.start();
const reasoners: Reasoner[] = [createFakeReasoner()];
if (config.reasonerType === 'pi') {
  reasoners.push(createPiReasoner({
    config,
    client: await createPiSdkClient(config),
  }));
}
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
const reasoningWorker = createReasoningJobWorker(
  config,
  store,
  createReasonerRegistry(reasoners),
  undefined,
  createMemoryRetriever(store),
  runtimeClient,
);
reasoningWorker.start();
const app = createApp(
  config,
  store,
  incidentEngine,
  evidenceWorker,
  investigationLoop,
  investigationEvidence,
);

console.log(`[pi-ops-agent] starting on :${config.port}, db=${config.sqlitePath}`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`[pi-ops-agent] listening on :${config.port}`);
