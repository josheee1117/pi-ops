import { it } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deterministicSummary } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import { createEventStore } from '../store.js';
import { createIncidentEngine } from '../incident.js';
import { createInvestigationLoopService } from '../investigation-loop.js';
import { makeAgentConfig } from './test-config.js';

it('reads a complete diagnosis through real HTTP after ingress, callback and SQLite reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'incident-brief-'));
  const sqlitePath = join(directory, 'agent.sqlite');
  let store = createEventStore(sqlitePath);
  const config = makeAgentConfig({ sqlitePath, piRuntimeToken: 'runtime-token' });
  const start = () => {
    const loop = createInvestigationLoopService(store);
    const app = createApp(config, store, createIncidentEngine(store, config), undefined, loop);
    return serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  };
  let server = start();
  const stop = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const base = () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP listener');
    return `http://127.0.0.1:${address.port}`;
  };
  const post = (path: string, token: string, body: unknown) => fetch(`${base()}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await once(server, 'listening');
    const time = '2026-10-21T00:00:00Z';
    const ingested = await post('/v1/events', 'ingest-token', { producer: { id: 'local', type: 'application', version: '1' },
      events: [{ schemaVersion: 1, id: 'event-brief', time, source: 'application', service: 'orders', nodeId: 'node-1', type: 'business.error', severity: 'error', message: 'request failed', attributes: {} }] });
    assert.equal(ingested.status, 200);
    const incidents = await fetch(`${base()}/v1/ops/incidents`, { headers: { Authorization: 'Bearer operator-token' } });
    const incidentId: string = (await incidents.json()).incidents[0].id;
    const url = `/v1/ops/incidents/${incidentId}/brief?format=markdown`;
    const pending = await fetch(`${base()}${url}`, { headers: { Authorization: 'Bearer operator-token' } });
    assert.match(await pending.text(), /诊断尚未完成/);
    const submitted = await post('/v1/ops/investigations', 'operator-token', { incidentId });
    assert.equal(submitted.status, 200);
    const session = await submitted.json();
    const diagnosis = {
      summary: deterministicSummary({ service: 'orders', type: 'business.error' }), observations: [],
      candidateCauses: [{ cause: '触发分支未知。', supportingEvidenceIds: [], contradictingEvidenceIds: [] }],
      uncertainties: ['缺少对应版本源码。'], actions: [{ purpose: 'evidence_collection', target: 'orders 异常入口', preconditions: ['只读权限。'], operation: '读取故障版本源码并核对抛错分支。', expectedResult: '找到抛错条件。', risk: '只读，不重放写请求。', requiresApproval: false, evidenceIds: [] }],
    };
    const callback = await post('/v1/investigation-results', 'runtime-token', {
      schemaVersion: 1, runtimeRequestId: session.runtimeRequestId, runtimeTaskId: `rt-${session.runtimeRequestId}`, sessionId: session.sessionId, status: 'completed',
      report: { hypothesis: '触发分支未知。', recommendation: '核对源码。', confidence: 0.2, supportingEvidenceIds: [], contradictingEvidenceIds: [], diagnosis },
    });
    assert.equal(callback.status, 200, await callback.text());
    await stop(); store.close(); store = createEventStore(sqlitePath); server = start();
    await once(server, 'listening');
    for (const token of [undefined, 'ingest-token', 'runtime-token']) {
      assert.equal((await fetch(`${base()}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).status, 401);
    }
    const detail = await fetch(`${base()}${url}`, { headers: { Authorization: 'Bearer operator-token' } });
    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get('cache-control'), 'no-store');
    const text = await detail.text();
    assert.match(text, /容器名、环境名或源码具备注入能力，均不能证明本次是演练、误报或预期行为/);
    assert.match(text, /没有明确证据前，按真实故障处理/);
    assert.match(text, /业务影响未确认时先核实，不写[“"]未影响[”"]/);
    for (const expected of [incidentId, '完整诊断', '证据摘要', diagnosis.actions[0]!.operation, diagnosis.actions[0]!.risk]) assert.ok(text.includes(expected), expected);
    const json = await fetch(`${base()}/v1/ops/incidents/${incidentId}/brief`, { headers: { Authorization: 'Bearer operator-token' } });
    assert.deepEqual((await json.json()).reports[0].diagnosis, diagnosis);
  } finally { await stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
