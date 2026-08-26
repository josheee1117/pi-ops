import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createPiRuntimeApp } from './app.js';
import { createFakeRuntimeModel } from './model.js';
import { createPiSdkRuntimeModel } from './pi-session.js';

const config = loadConfig();
const model = config.piProvider && config.piModel
  ? await createPiSdkRuntimeModel(config)
  : createFakeRuntimeModel();
const runtime = createPiRuntimeApp(config, { model });

console.log(`[pi-runtime] starting on :${config.port} model=${model.provider}/${model.model}`);
serve({
  fetch: runtime.app.fetch,
  port: config.port,
});
console.log(`[pi-runtime] listening on :${config.port}`);
