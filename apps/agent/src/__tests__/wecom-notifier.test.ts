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
  it('renders first, diagnosis, recovery and notice types without diagnostics or secrets', async () => {
    const contents: string[] = [];
    const notifier = createWeComNotifier({
      webhookUrl: URL, detailsBaseUrl: 'https://ops.example', timeoutMs: 100, maxResponseBytes: 128,
      fetch: async (url, init) => {
        assert.equal(url, URL);
        assert.equal((init?.headers as Record<string, string>)['Idempotency-Key'], payload.notificationId);
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(Object.keys(body), ['msgtype', 'markdown']);
        contents.push(body.markdown.content);
        return success();
      },
    });
    for (const type of ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED', 'INCIDENT_RECOVERED'] as const) {
      await notifier.send({ ...payload, type, analysis: { investigationSessionId: 's', reasoningResultId: 'r',
        hypothesis: '诊断原文'.repeat(500), recommendation: '完整操作'.repeat(500), confidence: 0.8 } });
    }
    for (const notice of ['manual-confirmation', 'diagnosis-update', 'recovered-before-delivery'] as const) await notifier.send({ ...payload, notice });
    assert.match(contents[0]!, /故障通知/);
    assert.match(contents[1]!, /诊断更新/);
    assert.match(contents[2]!, /已恢复/);
    assert.match(contents[3]!, /需要人工确认/);
    assert.match(contents[5]!, /曾发生、现已恢复/);
    for (const content of contents) {
      assert.match(content, /场景：pi-ops-drill/);
      assert.match(content, /严重程度：严重/);
      assert.match(content, /编号：inc-1/);
      assert.match(content, /https:\/\/ops.example\/v1\/ops\/incidents\/inc-1\/brief\?format=markdown/);
      assert.ok(Buffer.byteLength(content) <= 4000);
      assert.doesNotMatch(content, /secret-key|诊断原文|完整操作|模型自评|evd-/);
    }
  });

  it('classifies nonzero errcode and HTTP errors as terminal', async () => {
    for (const response of [
      new Response(JSON.stringify({ errcode: 40058, errmsg: URL })),
      new Response(JSON.stringify({ errcode: 0 }), { status: 400 }),
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

  it('retries 503 non-JSON and 429 gateway responses', async () => {
    for (const status of [503, 429]) {
      const notifier = createWeComNotifier({
        webhookUrl: URL, timeoutMs: 100, maxResponseBytes: 128,
        fetch: async () => new Response('<html>gateway error</html>', { status }),
      });
      await assert.rejects(() => notifier.send(payload), (error: unknown) => {
        assert.ok(error instanceof RetryableNotificationError);
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      });
    }
  });

  it('retries 45009, network and timeout without exposing the webhook URL', async () => {
    const fetches: Array<typeof fetch> = [
      async () => new Response(JSON.stringify({ errcode: 45009 })),
      async () => { throw new TypeError(`fetch ${URL} failed`); },
      async (_url, init) => new Promise<Response>((_resolve, reject) => {
        // AbortSignal.timeout's timer does not keep the loop alive; a real socket would.
        const pending = setTimeout(() => {}, 60_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(pending);
          reject(init.signal?.reason);
        });
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
