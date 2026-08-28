import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createPiRuntimeApp } from './app.js';
import { createHttpRuntimeEvidenceClient } from './evidence-client.js';
import { createFakeRuntimeModel } from './model.js';
import { createPiSdkRuntimeModel } from './pi-session.js';

const config = loadConfig();
const requireReal = process.env['PI_OPS_REQUIRE_REAL_MODEL'] === '1';
if (requireReal && (!config.piProvider || !config.piModel)) {
  throw new Error('REAL model required: set PI_OPS_PI_PROVIDER and PI_OPS_PI_MODEL');
}
const model = config.piProvider && config.piModel
  ? await createPiSdkRuntimeModel(config)
  : createFakeRuntimeModel();
if (requireReal && (model.provider === 'fake' || model.model === 'deterministic')) {
  throw new Error('REAL model required: refused FakeRuntimeModel');
}
const modelMode = model.provider === 'fake' ? 'FAKE' : 'REAL';
const evidenceOrigin = new URL(config.callbackBaseUrl).origin;
const evidenceClient = createHttpRuntimeEvidenceClient({
  baseUrl: evidenceOrigin,
  token: config.token,
  timeoutMs: config.callbackTimeoutMs,
});
const runtime = createPiRuntimeApp(config, { model, evidenceClient });

process.stderr.write(`[pi-runtime] starting on :${config.port} model_mode=${modelMode} provider=${model.provider} model=${model.model}\n`);
serve({
  fetch: runtime.app.fetch,
  port: config.port,
});
console.log(`[pi-runtime] listening on :${config.port}`);
