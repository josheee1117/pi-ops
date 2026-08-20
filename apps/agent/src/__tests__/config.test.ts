import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

const CONFIG_KEYS = [
  'PI_OPS_INGEST_TOKEN',
  'PI_OPS_SQLITE_PATH',
  'PI_OPS_NODE_AGENTS',
  'PI_OPS_AGENT_PORT',
  'PI_OPS_MAX_BODY_SIZE',
  'PI_OPS_AGGREGATION_WINDOW_MS',
  'PI_OPS_EVIDENCE_TIMEOUT_MS',
  'PI_OPS_EVIDENCE_MAX_RESPONSE_BYTES',
  'PI_OPS_EVIDENCE_LOGS_MAX_LINES',
  'PI_OPS_EVIDENCE_JOB_POLL_INTERVAL_MS',
  'PI_OPS_EVIDENCE_JOB_MAX_ATTEMPTS',
  'PI_OPS_EVIDENCE_JOB_BATCH_SIZE',
  'PI_OPS_EVENT_REPLAY_BATCH_SIZE',
] as const;

function withConfigEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of CONFIG_KEYS) previous.set(key, process.env[key]);
  try {
    for (const key of CONFIG_KEYS) delete process.env[key];
    process.env['PI_OPS_INGEST_TOKEN'] = 'ingest-token';
    process.env['PI_OPS_SQLITE_PATH'] = ':memory:';
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('loadConfig node-agent registry', () => {
  it('loads node-agent endpoint and token from runtime JSON', () => {
    withConfigEnv({
      PI_OPS_NODE_AGENTS: JSON.stringify([
        { nodeId: 'test-svc-02', url: 'http://node-agent:8081/', token: 'node-token' },
      ]),
    }, () => {
      const config = loadConfig();
      assert.deepEqual(config.nodeAgents.get('test-svc-02'), {
        nodeId: 'test-svc-02',
        url: 'http://node-agent:8081',
        token: 'node-token',
      });
    });
  });

  it('fails fast on malformed node-agent JSON', () => {
    withConfigEnv({ PI_OPS_NODE_AGENTS: '{bad-json' }, () => {
      assert.throws(() => loadConfig(), /valid JSON/);
    });
  });

  it('fails fast on duplicate node identities', () => {
    withConfigEnv({
      PI_OPS_NODE_AGENTS: JSON.stringify([
        { nodeId: 'node-1', url: 'http://one', token: 'a' },
        { nodeId: 'node-1', url: 'http://two', token: 'b' },
      ]),
    }, () => {
      assert.throws(() => loadConfig(), /Duplicate node-agent config/);
    });
  });

  it('rejects node-agent URLs outside plain HTTP(S)', () => {
    for (const url of [
      'file:///tmp/node-agent',
      'http://user:secret@node-agent:8081',
      'http://node-agent:8081/?token=secret',
      'not-a-url',
    ]) {
      withConfigEnv({
        PI_OPS_NODE_AGENTS: JSON.stringify([
          { nodeId: 'node-1', url, token: 'node-token' },
        ]),
      }, () => {
        assert.throws(() => loadConfig(), /Invalid node-agent URL/);
      });
    }
  });

  it('rejects malformed and out-of-range operational integers', () => {
    const invalidValues: Array<[string, string]> = [
      ['PI_OPS_AGENT_PORT', '0'],
      ['PI_OPS_AGENT_PORT', '65536'],
      ['PI_OPS_AGENT_PORT', '8080garbage'],
      ['PI_OPS_MAX_BODY_SIZE', '-1'],
      ['PI_OPS_AGGREGATION_WINDOW_MS', 'NaN'],
      ['PI_OPS_EVIDENCE_TIMEOUT_MS', '0'],
      ['PI_OPS_EVIDENCE_MAX_RESPONSE_BYTES', '1.5'],
      ['PI_OPS_EVIDENCE_LOGS_MAX_LINES', '0'],
      ['PI_OPS_EVIDENCE_JOB_POLL_INTERVAL_MS', '-10'],
      ['PI_OPS_EVIDENCE_JOB_MAX_ATTEMPTS', '101'],
      ['PI_OPS_EVIDENCE_JOB_BATCH_SIZE', '1001'],
      ['PI_OPS_EVENT_REPLAY_BATCH_SIZE', '10001'],
    ];

    for (const [key, value] of invalidValues) {
      withConfigEnv({ [key]: value }, () => {
        assert.throws(() => loadConfig(), new RegExp(key));
      });
    }
  });

  it('keeps PI_OPS_SQLITE_PATH required', () => {
    withConfigEnv({ PI_OPS_SQLITE_PATH: undefined }, () => {
      assert.throws(() => loadConfig(), /PI_OPS_SQLITE_PATH/);
    });
  });
});
