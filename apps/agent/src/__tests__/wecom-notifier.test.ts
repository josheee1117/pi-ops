import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWeComNotifier, RetryableNotificationError, TerminalNotificationError } from '../notifier.js';
import type { NotificationPayload } from '../notification.js';

const URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key';
const payload: NotificationPayload = {
  schemaVersion: 1,
  notificationId: 'njob-open-inc-1',
  type: 'INCIDENT_OPEN',
  incident: {
    id: 'inc-1', service: 'pi-ops-drill', nodeId: 'test-ai-01', type: 'health.failure',
    severity: 'error', state: 'OPEN', firstSeen: '2026-09-25T10:00:00Z', lastSeen: '2026-09-25T10:01:00Z',
  },
  facts: { eventCount: 3, evidenceIds: ['evd-1', 'evd-2'] },
};

const success = () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }));

describe('WeCom notifier', () => {
  it('sends three markdown templates with ordered incident facts and an Idempotency-Key', async () => {
    const contents: string[] = [];
    const notifier = createWeComNotifier({
      webhookUrl: URL, timeoutMs: 100, maxResponseBytes: 128,
      fetch: async (url, init) => {
        assert.equal(url, URL);
        assert.equal(init?.method, 'POST');
        assert.equal((init?.headers as Record<string, string>)['Idempotency-Key'], payload.notificationId);
        const body = JSON.parse(init?.body as string);
        assert.equal(body.msgtype, 'markdown');
        assert.deepEqual(Object.keys(body), ['msgtype', 'markdown']);
        contents.push(body.markdown.content);
        return success();
      },
    });
    for (const type of ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED', 'INCIDENT_RECOVERED'] as const) {
      await notifier.send({
        ...payload, type,
        ...(type === 'INVESTIGATION_COMPLETED' ? { analysis: {
          investigationSessionId: 'session-1', reasoningResultId: 'result-1',
          hypothesis: 'probe failed', confidence: 0.8, recommendation: 'check service',
        } } : {}),
      });
    }
    assert.match(contents[0]!, /Incident OPEN/);
    assert.match(contents[1]!, /Investigation COMPLETED/);
    assert.match(contents[2]!, /Incident RECOVERED/);
    for (const content of contents) {
      const fields = ['service:', 'node:', 'type:', 'time:', 'eventCount:', 'evidence:', 'incident id:'];
      assert.deepEqual(fields.map((field) => content.indexOf(field)), [...fields.map((field) => content.indexOf(field))].sort((a, b) => a - b));
      assert.match(content, /health\.failure/);
      assert.match(content, /eventCount: 3/);
      assert.match(content, /evidence: 2/);
    }
    assert.match(contents[1]!, /hypothesis: probe failed \(0\.8\)\n> recommendation: check service\n> incident id:/);
    assert.doesNotMatch(contents[0]!, /hypothesis:/);
    assert.doesNotMatch(contents[2]!, /recommendation:/);
    await notifier.send({ ...payload, type: 'INVESTIGATION_COMPLETED' });
    assert.doesNotMatch(contents[3]!, /hypothesis:|recommendation:/);
  });

  it('truncates recommendation before hypothesis at 4000 UTF-8 bytes', async () => {
    const contents: string[] = [];
    const notifier = createWeComNotifier({
      webhookUrl: URL, timeoutMs: 100, maxResponseBytes: 128,
      fetch: async (_url, init) => {
        contents.push(JSON.parse(init?.body as string).markdown.content);
        return success();
      },
    });
    const analysis = {
      investigationSessionId: 'session-1', reasoningResultId: 'result-1',
      hypothesis: '原因', confidence: 0.8, recommendation: '修'.repeat(2000),
    };
    await notifier.send({ ...payload, type: 'INVESTIGATION_COMPLETED', analysis });
    assert.ok(Buffer.byteLength(contents[0]!, 'utf8') <= 4000);
    assert.match(contents[0]!, /hypothesis: 原因 \(0\.8\)/);
    assert.ok((contents[0]!.match(/修/g) ?? []).length < 2000);
    await notifier.send({ ...payload, type: 'INVESTIGATION_COMPLETED', analysis: {
      ...analysis, hypothesis: '因'.repeat(2000),
    } });
    assert.ok(Buffer.byteLength(contents[1]!, 'utf8') <= 4000);
    assert.doesNotMatch(contents[1]!, /修/);
    assert.match(contents[1]!, /因/);
  });

  it('classifies nonzero errcode and HTTP errors as terminal', async () => {
    for (const response of [
      new Response(JSON.stringify({ errcode: 40058, errmsg: URL })),
      new Response(JSON.stringify({ errcode: 0 }), { status: 500 }),
      new Response('not-json', { status: 200 }),
    ]) {
      const notifier = createWeComNotifier({ webhookUrl: URL, timeoutMs: 100, maxResponseBytes: 128, fetch: async () => response });
      await assert.rejects(() => notifier.send(payload), (error: unknown) => {
        assert.ok(error instanceof TerminalNotificationError);
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      });
    }
  });

  it('retries 45009, network and timeout without exposing the webhook URL', async () => {
    const fetches: Array<typeof fetch> = [
      async () => new Response(JSON.stringify({ errcode: 45009 }), { status: 429 }),
      async () => { throw new TypeError(`fetch ${URL} failed`); },
      async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
    ];
    for (const fakeFetch of fetches) {
      const notifier = createWeComNotifier({ webhookUrl: URL, timeoutMs: 20, maxResponseBytes: 128, fetch: fakeFetch });
      await assert.rejects(() => notifier.send(payload), (error: unknown) => {
        assert.ok(error instanceof RetryableNotificationError);
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      });
    }
  });
});
