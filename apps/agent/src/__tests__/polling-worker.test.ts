import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createPollingWorker } from '../polling-worker.js';
import { makeAgentConfig } from './test-config.js';

it('polling workers coalesce wakes, serialize drains and await active work on stop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let resets = 0;
  let release!: () => void;
  const worker = createPollingWorker({
    name: 'test', intervalMs: 10,
    reset: () => ++resets,
    async drain() {
      calls++;
      await new Promise<void>((resolve) => { release = resolve; });
    },
  });
  worker.start();
  worker.wake();
  worker.wake();
  await Promise.resolve();
  assert.equal(resets, 1);
  assert.equal(calls, 1);
  const concurrent = worker.runOnce();
  t.mock.timers.tick(10);
  await Promise.resolve();
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([concurrent, stopping]);
  assert.equal(stopped, true);
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(calls, 1);
});

it('polling workers clear a failed drain so later jobs can run', async () => {
  let calls = 0;
  const worker = createPollingWorker({
    name: 'test', intervalMs: 10, reset: () => 0,
    async drain() { if (++calls === 1) throw new Error('unavailable'); },
  });
  await assert.rejects(worker.runOnce(), /unavailable/);
  await worker.runOnce();
  assert.equal(calls, 2);
  await worker.stop();
});

it('test configs preserve overrides and do not share mutable node maps', () => {
  const first = makeAgentConfig({ evidenceTimeoutMs: 17 });
  first.nodeAgents.set('n', { nodeId: 'n', url: 'http://localhost', token: 'test' });
  assert.equal(first.evidenceTimeoutMs, 17);
  assert.equal(makeAgentConfig().nodeAgents.size, 0);
});
