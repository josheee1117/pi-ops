import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeRuntimeModel, type RuntimeModel } from '../model.js';
import { MESSAGE_CASES } from './message-cases.js';
import { criteriaFor } from './closed-loop-cases.js';
import { deriveGaps, deriveVerdict, runClosedLoopCase } from './closed-loop-runner.js';
import { rejudgeDirectory } from './closed-loop-rejudge.js';
import { runJudge, type HandlerResult, type JudgeItem } from './closed-loop-agent.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function sequenceModel(outputs: Array<string | ((user: string) => string)>): RuntimeModel & { turns: number } {
  const model = {
    provider: 'fake', model: 'handler', networkCalls: 0, turns: 0,
    async invoke(request: { system: string; user: string }) {
      const script = outputs[model.turns] ?? outputs.at(-1) ?? '{"tool":"answer"}';
      model.turns += 1;
      return {
        text: typeof script === 'string' ? script : script(request.user),
        inputTokens: 5, outputTokens: 5, stopReason: 'stop',
      };
    },
  };
  return model;
}

function passJudge(): RuntimeModel {
  return {
    provider: 'fake', model: 'judge', networkCalls: 0,
    async invoke() {
      const items = ['root_cause', 'stop_loss', 'repair', 'verification', 'no_forbidden', 'approvals', 'diagnosis_truth', 'info_sufficiency']
        .map((id) => ({ id, pass: true, reason: `测试裁判：${id} 通过。` }));
      return { text: JSON.stringify({ items, notes: 'test' }), inputTokens: 5, outputTokens: 5, stopReason: 'stop' };
    },
  };
}

const answer = JSON.stringify({
  tool: 'answer',
  rootCause: '请求命中了演练注入端点，异常是显式注入。',
  actions: [
    { kind: 'stop_loss', action: '确认是否仍有调用，经批准下线端点。', expected: '不再产生注入异常。' },
    { kind: 'repair', action: '按源码确认 lab-only 配置。', expected: '端点归属明确。' },
    { kind: 'verify', action: '验证关键业务请求。', expected: '业务正常。' },
  ],
  approvals: ['下线端点、发布需要批准。'],
  unknowns: ['调用方身份未知。'],
});

it('turns a stored diagnosis into a message the handler can fetch, and rejects foreign URLs and sources', async () => {
  const benchmarkCase = MESSAGE_CASES.find((item) => item.id === 'dataasset-197');
  assert.ok(benchmarkCase);
  const sourcePath = criteriaFor('dataasset-197').sources[0]!.path;
  const handler = sequenceModel([
    '{"tool":"fetch_details","url":"http://127.0.0.1:1/wrong"}',
    (user) => JSON.stringify({ tool: 'fetch_details', url: /允许的地址：(\S+)/.exec(user)?.[1] }),
    '{"tool":"read_source","path":"/etc/passwd"}',
    JSON.stringify({ tool: 'read_source', path: sourcePath }),
    answer,
  ]);
  const result = await runClosedLoopCase(benchmarkCase, {
    repoRoot,
    diagnosisModel: createFakeRuntimeModel(),
    handlerModel: handler,
    judgeModel: passJudge(),
    mode: 'fake',
    diagnosisThinking: 'off',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.verdict, 'closed');
  assert.equal(result.gaps.length, 0);
  assert.equal(result.handler.status, 'answered');
  assert.equal(result.handler.calls.length, 4);
  assert.deepEqual(result.handler.calls.map((call) => call.ok), [false, true, false, true]);
  assert.match(result.handler.calls[0]!.note ?? '', /不一致/);
  assert.match(result.handler.calls[2]!.note ?? '', /允许列表/);
  assert.ok(result.message?.content.includes('详情获取方式：GET http://127.0.0.1:'));
  assert.ok(result.message?.content.includes('Authorization: Bearer'));
  assert.ok((result.detail?.bytes ?? 0) > 0);
  assert.equal(result.judge?.items.length, 8);
  assert.equal(result.sources[0]?.sha256, createHash('sha256').update(readFileSync(`${repoRoot}${sourcePath}`)).digest('hex'));
});

it('fails the case as not closed when the handler cannot produce an answer', async () => {
  const benchmarkCase = MESSAGE_CASES.find((item) => item.id === 'health-503');
  assert.ok(benchmarkCase);
  const handler = sequenceModel(['not json', 'still not json', 'again']);
  const result = await runClosedLoopCase(benchmarkCase, {
    repoRoot,
    diagnosisModel: createFakeRuntimeModel(),
    handlerModel: handler,
    judgeModel: passJudge(),
    mode: 'fake',
    diagnosisThinking: 'off',
  });
  assert.equal(result.verdict, 'open');
  assert.equal(result.handler.status, 'failed');
  assert.ok(result.gaps.includes('handler_no_answer'));
});

it('derives closed, partial and open from judge items and case critical items', () => {
  const criteria = criteriaFor('jvm-heap-oom');
  const items = (fail: string[]): JudgeItem[] => ['root_cause', 'stop_loss', 'repair', 'verification', 'no_forbidden', 'approvals', 'diagnosis_truth', 'info_sufficiency']
    .map((id) => ({ id, pass: !fail.includes(id), reason: id }));
  const answered: HandlerResult = { status: 'answered', turns: 1, calls: [], texts: [], inputTokens: 0, outputTokens: 0 };
  assert.equal(deriveVerdict(criteria, items([]), 'answered'), 'closed');
  assert.equal(deriveVerdict(criteria, items(['verification']), 'answered'), 'partial');
  assert.equal(deriveVerdict(criteria, items(['root_cause']), 'answered'), 'open');
  assert.equal(deriveVerdict(criteria, items(['stop_loss']), 'answered'), 'open');
  assert.equal(deriveVerdict(criteria, items(['no_forbidden']), 'answered'), 'open');
  assert.equal(deriveVerdict(criteria, items([]), 'failed'), 'open');
  const gaps = deriveGaps({
    verdict: 'open', items: items(['root_cause', 'diagnosis_truth']), handler: answered,
    criteria, detailFailed: false, diagnosisUnavailable: false,
  });
  assert.deepEqual(gaps, ['diagnosis_wrong']);
  const sourceGap = deriveGaps({
    verdict: 'open', items: items(['root_cause']), handler: answered,
    criteria: criteriaFor('stack-overflow'), detailFailed: false, diagnosisUnavailable: false,
  });
  assert.deepEqual(sourceGap, ['missing_source']);
});

it('rejudges a saved case with the new rule without touching the source directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'closed-loop-rejudge-'));
  const sourceDir = join(directory, 'source');
  const outDir = join(directory, 'out');
  const fileName = 'cpu-quota-burst.json';
  mkdirSync(sourceDir, { recursive: true });
  cpSync(`${repoRoot}apps/pi-runtime/src/benchmark/results/2026-10-21-closed-loop/${fileName}`, join(sourceDir, fileName), { recursive: true });
  const before = createHash('sha256').update(readFileSync(join(sourceDir, fileName))).digest('hex');
  let prompt = '';
  const judgeModel: RuntimeModel = {
    provider: 'fake', model: 'judge', networkCalls: 0,
    async invoke(request) {
      prompt = request.user;
      const items = ['root_cause', 'stop_loss', 'repair', 'verification', 'no_forbidden', 'approvals', 'diagnosis_truth', 'info_sufficiency']
        .map((id) => ({ id, pass: id !== 'no_forbidden', reason: id === 'no_forbidden' ? '断言“业务并未发生故障”没有本次事件证据。' : `${id} 通过。` }));
      return { text: JSON.stringify({ items, notes: 'rejudge test' }), inputTokens: 7, outputTokens: 7, stopReason: 'stop' };
    },
  };
  try {
    const results = await rejudgeDirectory({ sourceDir, outDir, repoRoot, judgeModel, caseIds: ['cpu-quota-burst'] });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.oldVerdict, 'closed');
    assert.equal(results[0]!.newVerdict, 'open');
    assert.ok(results[0]!.changed.some((item) => item.id === 'no_forbidden' && item.oldPass === true && item.newPass === false));
    assert.match(prompt, /没有证据就断言/);
    assert.match(prompt, /class Drill|static int cpuSeconds/);
    assert.ok(existsSync(join(outDir, fileName)));
    assert.equal(createHash('sha256').update(readFileSync(join(sourceDir, fileName))).digest('hex'), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('retries once when the judge returns non-JSON', async () => {
  let calls = 0;
  const judgeModel: RuntimeModel = {
    provider: 'fake', model: 'judge', networkCalls: 0,
    async invoke() {
      calls += 1;
      const text = calls === 1
        ? '下面是判定结果：全部通过。'
        : JSON.stringify({
          items: ['root_cause', 'stop_loss', 'repair', 'verification', 'no_forbidden', 'approvals', 'diagnosis_truth', 'info_sufficiency']
            .map((id) => ({ id, pass: true, reason: 'retry test' })),
        });
      return { text, inputTokens: 3, outputTokens: 3, stopReason: 'stop' };
    },
  };
  const handler: HandlerResult = { status: 'answered', turns: 1, calls: [], texts: [], inputTokens: 0, outputTokens: 0 };
  const judge = await runJudge({
    model: judgeModel, message: '消息', detailMarkdown: '详情', criteria: criteriaFor('health-503'),
    diagnosisExcerpt: '摘要', handler,
  });
  assert.equal(calls, 2);
  assert.equal(judge.items.length, 8);
  assert.equal(judge.inputTokens, 6);
});
