import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createEventSender } from './events/sender.js';
import { createDockerWatcher } from './events/watcher.js';

const config = loadConfig();
const app = createApp(config);

// Start event sender (background flush loop)
const sender = createEventSender(config);
sender.start();

// Start Docker event watcher (if agent URL is configured)
if (config.ingestToken) {
  const watcher = createDockerWatcher(config, sender);
  watcher.start().catch((err) => {
    console.warn(`[pi-ops-node-agent] Docker event watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
    console.warn('[pi-ops-node-agent] continuing without Docker event source');
  });
} else {
  console.log('[pi-ops-node-agent] Docker event source disabled (PI_OPS_INGEST_TOKEN not set)');
}

console.log(`[pi-ops-node-agent] starting on :${config.port}, node=${config.nodeId}`);
console.log(`[pi-ops-node-agent] allowed containers: ${[...config.allowedContainers].join(', ') || '(none)'}`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`[pi-ops-node-agent] listening on :${config.port}`);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[pi-ops-node-agent] SIGTERM received, shutting down...');
  await sender.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[pi-ops-node-agent] SIGINT received, shutting down...');
  await sender.stop();
  process.exit(0);
});