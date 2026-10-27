import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModelConfig } from './message-cli.js';
import { createLiveBenchmarkModel } from './live-model.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const out = resolve(root, process.argv[2] ?? 'artifacts/output-budget/request-before.json');
let request: unknown;
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (typeof init?.body === 'string') {
    const body = JSON.parse(init.body);
    request = {
      model: body.model, max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens,
      thinking: body.thinking ?? null, reasoning_effort: body.reasoning_effort ?? null,
      stream: body.stream, messageCount: body.messages?.length,
    };
  }
  return new Response('data: {"id":"capture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"capture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
};
try {
  const config = readModelConfig(resolve(root, 'artifacts/real-dataasset-lab/central/runtime-secrets.env'));
  const { model } = await createLiveBenchmarkModel(config);
  const response = await model.invoke({ system: 'Return ok.', user: 'Return ok.' });
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify({ transport: 'fake fetch; no network', request, effectiveThinking: model.effectiveThinkingLevel, response }, null, 2) + '\n');
  console.log(JSON.stringify({ request, effectiveThinking: model.effectiveThinkingLevel }));
} finally {
  globalThis.fetch = original;
}
