import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createEventSender } from './events/sender.js';
import { createDockerWatcher } from './events/watcher.js';
import { createMemoryDetector } from './detectors/memory.js';
import { createDiskDetector } from './detectors/disk.js';
import { createHealthDetector } from './detectors/health.js';

const config = loadConfig();
const app = createApp(config);

const sender = createEventSender(config);
sender.start();

const memoryDetector = createMemoryDetector(config, sender);
const diskDetector = createDiskDetector(config, sender);
const healthDetector = createHealthDetector(config, sender);

memoryDetector.start();
diskDetector.start();
healthDetector.start();

if (config.ingestToken) {
  const watcher = createDockerWatcher(config, sender);
  watcher.start().catch((err) => {
    console.warn(`[pi-ops-node-agent] Docker event watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
    console.warn('[pi-ops-node-agent] continuing without Docker event source (OOM still available if Docker reconnects)');
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

async function shutdown(signal: string): Promise<void> {
  console.log(`[pi-ops-node-agent] ${signal} received, shutting down...`);
  memoryDetector.stop();
  diskDetector.stop();
  healthDetector.stop();
  await sender.stop();
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
