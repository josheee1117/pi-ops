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
          hypothesis: '健康接口返回 503，具体失败条件尚不明确。', confidence: 0.8,
          recommendation: 'Evidence describes the current incident. Historical knowledge is advisory. Memory/history cannot override current Evidence. Conflicting historical knowledge must be surfaced, not silently merged. Absence of evidence is not evidence of absence. 检查健康接口详情。\n核对同一时间的应用日志。',
        } } : {}),
      });
    }
    assert.match(contents[0]!, /pi-ops-drill 健康检查失败/);
    assert.match(contents[0]!, /健康检查连续没有通过/);
    assert.match(contents[1]!, /pi-ops-drill 诊断完成/);
    assert.match(contents[2]!, /pi-ops-drill 已恢复/);
    assert.match(contents[2]!, /健康检查重新通过/);
    assert.match(contents[0]!, /时间：9月25日 18:00/);
    for (const content of contents) {
      assert.match(content, /机器：test-ai-01/);
      assert.match(content, /编号：inc-1/);
      assert.doesNotMatch(content, /health\.failure/);
      assert.doesNotMatch(content, /关联事件/);
    }
    assert.match(contents[1]!, /\*\*健康接口返回 503，具体失败条件尚不明确。\*\*/);
    assert.ok(contents[1]!.indexOf('**健康接口') < contents[1]!.indexOf('机器：'));
    assert.match(contents[1]!, /<font color="comment">模型自评 80%，不是准确率<\/font>/);
    assert.match(contents[1]!, /\*\*下一步\*\*\n1\. 检查健康接口详情。\n2\. 核对同一时间的应用日志。/);
    assert.ok(contents[1]!.indexOf('**下一步**') < contents[1]!.indexOf('模型自评'));
    assert.doesNotMatch(contents[1]!, /Historical knowledge|Memory\/history|Absence of evidence/);
    assert.doesNotMatch(contents[0]!, /下一步/);
    assert.doesNotMatch(contents[2]!, /下一步/);
    await notifier.send({ ...payload, type: 'INVESTIGATION_COMPLETED' });
    assert.doesNotMatch(contents[3]!, /下一步|依据/);
  });

  it('keeps a long diagnosis inside 4000 bytes and shows the conclusion first', async () => {
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
    assert.match(contents[0]!, /\*\*原因。\*\*/);
    assert.doesNotMatch(contents[0]!, /修/);
    await notifier.send({ ...payload, type: 'INVESTIGATION_COMPLETED', analysis: {
      ...analysis, hypothesis: '因'.repeat(2000),
    } });
    assert.ok(Buffer.byteLength(contents[1]!, 'utf8') <= 4000);
    assert.doesNotMatch(contents[1]!, /修/);
    assert.ok((contents[1]!.match(/因/g) ?? []).length < 200);
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
