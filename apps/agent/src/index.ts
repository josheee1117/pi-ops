import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createEventStore } from './store.js';
import { createIncidentEngine } from './incident.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = createEventStore(config.sqlitePath);
const incidentEngine = createIncidentEngine(store, {
  aggregationWindowMs: config.aggregationWindowMs,
});
const app = createApp(config, store, incidentEngine);

console.log(`[pi-ops-agent] starting on :${config.port}, db=${config.sqlitePath}`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`[pi-ops-agent] listening on :${config.port}`);