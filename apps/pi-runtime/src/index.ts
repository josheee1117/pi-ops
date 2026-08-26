import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createPiRuntimeApp } from './app.js';

const config = loadConfig();
const runtime = createPiRuntimeApp(config);

console.log(`[pi-runtime] starting on :${config.port}`);
serve({
  fetch: runtime.app.fetch,
  port: config.port,
});
console.log(`[pi-runtime] listening on :${config.port}`);
