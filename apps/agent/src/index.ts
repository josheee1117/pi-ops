import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createEventStore } from './store.js';
import { createIncidentEngine } from './incident.js';
import { createEvidenceOrchestrator } from './evidence-orchestrator.js';
import { createEvidenceJobWorker } from './evidence-worker.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = createEventStore(config.sqlitePath);
const incidentEngine = createIncidentEngine(store, {
  aggregationWindowMs: config.aggregationWindowMs,
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
const evidenceOrchestrator = createEvidenceOrchestrator(config, store);
const evidenceWorker = createEvidenceJobWorker(config, store, evidenceOrchestrator);
evidenceWorker.start();
const app = createApp(config, store, incidentEngine, evidenceWorker);

console.log(`[pi-ops-agent] starting on :${config.port}, db=${config.sqlitePath}`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`[pi-ops-agent] listening on :${config.port}`);