import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createEventStore } from './store.js';
import { createApp } from './app.js';

const config = loadConfig();
const store = createEventStore(config.sqlitePath);
const app = createApp(config, store);

console.log(`[pi-ops-agent] starting on :${config.port}, db=${config.sqlitePath}`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`[pi-ops-agent] listening on :${config.port}`);