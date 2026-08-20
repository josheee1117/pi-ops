import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp(config);

console.log(`[pi-ops-node-agent] starting on :${config.port}, node=${config.nodeId}`);
console.log(`[pi-ops-node-agent] allowed containers: ${[...config.allowedContainers].join(', ') || '(none)'}`);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`[pi-ops-node-agent] listening on :${config.port}`);