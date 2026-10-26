import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_CASES } from './message-cases.js';
import { projectCase } from './agent-chain.js';
import { openCaseAgentServer } from './closed-loop-server.js';
import { runCase } from './runner.js';
import { createFakeRuntimeModel } from '../model.js';
import { CURRENT_EVIDENCE_LIMITS } from '../specialists.js';

function snippetOf(context: Awaited<ReturnType<typeof projectCase>>) {
  const found = context.evidence.find((item) => item.kind === 'source.snippet');
  assert.ok(found, 'projected context must carry a source.snippet evidence item');
  return found.data as Record<string, unknown>;
}

it('projects the DataAsset fixture through the same reader the agent uses', async () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'dataasset-197');
  assert.ok(sample);
  const data = snippetOf(await projectCase(sample));
  assert.equal(data['service'], 'rdl-dataasset-6dfb8e88');
  assert.equal(data['file'], 'LabFaultController.java');
  assert.equal(data['className'], 'com.mbkj.dap.lab.LabFaultController');
  assert.equal(data['method'], 'serverFault');
  assert.equal(data['stackLine'], 25);
  assert.equal(data['versionStatus'], 'unchecked');
  assert.match(String(data['versionNote']), /版本未核对/);
  assert.match(String(data['text']), /throw new IllegalStateException\("Real DataAsset lab fault injection"\)/);
  assert.match(String(data['text']), /@ConditionalOnProperty/);
  assert.doesNotMatch(String(data['file']), /^\//);
});

it('projects the synthetic stack overflow fixture at Recurse.down line 7', async () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'stack-overflow');
  assert.ok(sample);
  const data = snippetOf(await projectCase(sample));
  assert.equal(data['file'], 'Recurse.java');
  assert.equal(data['className'], 'com.example.Recurse');
  assert.equal(data['method'], 'down');
  assert.equal(data['stackLine'], 7);
  assert.equal(data['versionStatus'], 'unchecked');
  assert.ok(Number(data['startLine']) <= 7 && Number(data['endLine']) >= 7);
  assert.match(String(data['text']), /return down\(depth \+ 1\) \+ depth;/);
});

it('stores a report citing the projected source id and hides its text over real HTTP', async () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'dataasset-197');
  assert.ok(sample);
  const outcome = await runCase(sample, { model: createFakeRuntimeModel(), mode: 'fake', thinkingLevel: 'off' });
  const report = outcome.investigation.report;
  const source = (await projectCase(sample)).evidence.find((item) => item.kind === 'source.snippet');
  assert.ok(report && source);
  report.supportingEvidenceIds.push(source.id);
  assert.equal(outcome.repairKind, 'undetermined');
  const server = await openCaseAgentServer(sample, report, sample.evidence);
  try {
    assert.match(server.detailMarkdown, new RegExp(source.id));
    assert.equal((server.detailMarkdown.match(/"kind": "source\.snippet"/g) ?? []).length, 1);
    assert.doesNotMatch(server.detailMarkdown, /throw new IllegalStateException/);
    assert.doesNotMatch(server.message, /throw new IllegalStateException/);
    const response = await fetch(server.detailUrl, { headers: { Authorization: `Bearer ${server.operatorToken}` } });
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /throw new IllegalStateException/);
  } finally {
    await server.close();
  }
});

it('requires version warnings and forbids guessing current configuration in the shared evidence limits', () => {
  assert.match(CURRENT_EVIDENCE_LIMITS, /unchecked.*必须.*版本未核对/);
  assert.match(CURRENT_EVIDENCE_LIMITS, /drifted.*missing.*不得.*stackLine/);
  assert.match(CURRENT_EVIDENCE_LIMITS, /配置当前值仍然不能猜/);
});

it('adds a missing source snippet for a case whose stack has no configured root', async () => {
  const sample = MESSAGE_CASES.find((item) => item.id === 'tag-group-502');
  assert.ok(sample);
  const data = snippetOf(await projectCase(sample));
  assert.equal(data['versionStatus'], 'missing');
  assert.equal(data['text'], '');
  assert.match(String(data['versionNote']), /未配置源码根目录/);
});
