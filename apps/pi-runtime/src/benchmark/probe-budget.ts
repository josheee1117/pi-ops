import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readModelConfig } from './message-cli.js';

const root = new URL('../../../../', import.meta.url);
const config = readModelConfig(fileURLToPath(new URL('artifacts/real-dataasset-lab/central/runtime-secrets.env', root)));
const results = [];
for (const disabled of [false, true]) {
  const body = {
    model: config.model, messages: [{ role: 'user', content: '只回复 OK。' }],
    max_completion_tokens: 128, stream: false,
    ...(disabled ? { thinking: { type: 'disabled' } } : {}),
  };
  const response = await fetch('https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`upstream probe HTTP ${response.status}`);
  const result = await response.json();
  const choice = result.choices?.[0];
  results.push({
    request: body, model: result.model, finishReason: choice?.finish_reason,
    textChars: choice?.message?.content?.length ?? 0,
    thinkingChars: choice?.message?.reasoning_content?.length ?? 0,
    usage: result.usage,
  });
}
writeFileSync(fileURLToPath(new URL('apps/pi-runtime/src/benchmark/results/2026-10-21-output-budget/upstream-probe.json', root)), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
