import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

const CONFIG_KEYS = [
  'PI_OPS_INGEST_TOKEN',
  'PI_OPS_SQLITE_PATH',
  'PI_OPS_NODE_AGENTS',
] as const;

function withConfigEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of CONFIG_KEYS) previous.set(key, process.env[key]);
  try {
    process.env['PI_OPS_INGEST_TOKEN'] = 'ingest-token';
    process.env['PI_OPS_SQLITE_PATH'] = ':memory:';
    delete process.env['PI_OPS_NODE_AGENTS'];
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

  it('keeps PI_OPS_SQLITE_PATH required', () => {
    withConfigEnv({ PI_OPS_SQLITE_PATH: undefined }, () => {
      assert.throws(() => loadConfig(), /PI_OPS_SQLITE_PATH/);
    });
  });
});
