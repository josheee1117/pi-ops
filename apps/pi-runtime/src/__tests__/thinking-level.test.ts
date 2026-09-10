import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from '../thinking-level.js';

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const REQUIRED = {
  PI_OPS_PI_RUNTIME_TOKEN: 't',
  PI_OPS_PI_RUNTIME_SQLITE_PATH: ':memory:',
  PI_OPS_PI_RUNTIME_CALLBACK_URL: 'http://127.0.0.1/cb',
};

describe('Pi Runtime thinking level config', () => {
  it('H. production default stays off when unset', () => {
    withEnv({ ...REQUIRED, PI_OPS_PI_THINKING_LEVEL: undefined }, () => {
      assert.equal(loadConfig().piThinkingLevel, 'off');
      assert.equal(DEFAULT_THINKING_LEVEL, 'off');
    });
  });

  it('honors an explicit supported level without changing anything else', () => {
    withEnv({ ...REQUIRED, PI_OPS_PI_THINKING_LEVEL: 'high' }, () => {
      const config = loadConfig();
      assert.equal(config.piThinkingLevel, 'high');
      assert.equal(config.executionTimeoutMs, 30_000);
    });
  });

  it('rejects an unsupported level instead of silently falling back', () => {
    withEnv({ ...REQUIRED, PI_OPS_PI_THINKING_LEVEL: 'turbo' }, () => {
      assert.throws(() => loadConfig(), /unsupported thinking level: turbo/);
    });
  });

  it('accepts exactly the SDK ThinkingLevel union', () => {
    for (const level of THINKING_LEVELS) {
      withEnv({ ...REQUIRED, PI_OPS_PI_THINKING_LEVEL: level }, () => {
        assert.equal(loadConfig().piThinkingLevel, level);
      });
    }
  });
});
