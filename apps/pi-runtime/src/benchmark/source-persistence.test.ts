import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MESSAGE_CASES } from './message-cases.js';
import { runCase } from './runner.js';
import { createFakeRuntimeModel } from '../model.js';
import { withoutSourceSnippetBodies } from './agent-chain.js';
import { main as closedLoopCli } from './closed-loop-cli.js';
import { main as messageCli } from './message-cli.js';

const BODY = 'return down(depth + 1) + depth;';

/** CLI entrypoints log their plan to stdout; TAP output must stay clean. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

it('returns only source metadata in the persistable benchmark result while the model sees the body', async () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'stack-overflow');
  assert.ok(sample);
  const fake = createFakeRuntimeModel();
  let receivedBody = false;
  const result = await runCase(sample, {
    mode: 'fake', thinkingLevel: 'off',
    model: { ...fake, async invoke(request) {
      receivedBody ||= request.user.includes(BODY);
      return fake.invoke(request);
    } },
  });
  assert.equal(receivedBody, true);
  const source = result.modelContext?.evidence.find((item) => item.kind === 'source.snippet');
  assert.ok(source?.data && typeof source.data === 'object');
  assert.equal('text' in source.data, false);
  assert.match(JSON.stringify(source), /Recurse.java/);
  assert.doesNotMatch(JSON.stringify(result), /return down\(depth \+ 1\) \+ depth;/);
});

it('removes nested source bodies from saved results without changing repair actions or other evidence', async () => {
  const result = { results: [{ modelContext: { evidence: [
    { id: 'source-1', kind: 'source.snippet', data: { file: 'Recurse.java', startLine: 6, endLine: 8, versionStatus: 'unchecked', text: BODY } },
    { id: 'logs-1', kind: 'docker.logs', data: { text: 'log content' } },
  ] }, diagnosis: { actions: [{ purpose: 'repair', operation: '为 depth 增加终止条件。', evidenceIds: ['source-1'] }] } }] };
  const clean = await withoutSourceSnippetBodies(result);
  assert.equal(clean.results[0]!.modelContext.evidence[0]!.data.text, undefined);
  assert.equal(clean.results[0]!.modelContext.evidence[1]!.data.text, 'log content');
  assert.deepEqual(clean.results[0]!.diagnosis, result.results[0]!.diagnosis);
  assert.equal(result.results[0]!.modelContext.evidence[0]!.data.text, BODY);
});

it('writes closed-loop CLI artifacts without source bodies and keeps the repair classification', async () => {
  const out = mkdtempSync(join(tmpdir(), 'snippet-closed-loop-'));
  try {
    await quietly(() => closedLoopCli(['--case', 'stack-overflow', '--out', out]));
    for (const file of readdirSync(out)) assert.ok(!readFileSync(join(out, file), 'utf8').includes(BODY), file);
    const saved = JSON.parse(readFileSync(join(out, 'stack-overflow.json'), 'utf8'));
    assert.equal(saved.result.diagnosis.repairKind, 'fallback');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

it('removes source annotations when a model changes their whitespace or quote style', async () => {
  const snippet = { kind: 'source.snippet', data: { text: '@Profile("real-dataasset-lab")\n@ConditionalOnProperty(prefix = "lab.fault", name = "enabled")' } };
  const result = await withoutSourceSnippetBodies({ text: '条件 @Profile(real-dataasset-lab) 与 @ConditionalOnProperty(prefix="lab.fault", name="enabled")。' }, [snippet]);
  assert.doesNotMatch(result.text, /@Profile\(|@ConditionalOnProperty\(/);
  assert.match(result.text, /source omitted/);
});

it('does not persist source bodies echoed by a model', async () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'stack-overflow');
  assert.ok(sample);
  const fake = createFakeRuntimeModel();
  const result = await runCase(sample, {
    mode: 'fake', thinkingLevel: 'off',
    model: { ...fake, async invoke(request) {
      const response = await fake.invoke(request);
      const output = JSON.parse(response.text);
      output.summary = `递归片段为 ${BODY}，版本未核对。`;
      return { ...response, text: JSON.stringify(output) };
    } },
  });
  assert.ok(!JSON.stringify(result).includes(BODY));
});

it('writes message CLI case and summary files without source bodies', async () => {
  const out = mkdtempSync(join(tmpdir(), 'snippet-persistence-'));
  try {
    await quietly(() => messageCli(['--case', 'stack-overflow', '--out', out]));
    for (const file of readdirSync(out)) {
      const text = readFileSync(join(out, file), 'utf8');
      assert.ok(!text.includes(BODY), file);
    }
    const saved = JSON.parse(readFileSync(join(out, 'stack-overflow.json'), 'utf8'));
    const source = saved.modelContext.evidence.find((item: { kind: string }) => item.kind === 'source.snippet');
    assert.equal(source.data.file, 'Recurse.java');
    assert.equal(source.data.text, undefined);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
