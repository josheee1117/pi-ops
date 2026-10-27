import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

it('defaults to a bounded 300s investigation while preserving configurable short deadlines', () => {
  const previous = { ...process.env };
  try {
    process.env['PI_OPS_PI_RUNTIME_TOKEN'] = 'unit-only';
    process.env['PI_OPS_PI_RUNTIME_SQLITE_PATH'] = ':memory:';
    process.env['PI_OPS_PI_RUNTIME_CALLBACK_URL'] = 'http://localhost/callback';
    delete process.env['PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS'];
    assert.equal(loadConfig().executionTimeoutMs, 300_000);
    process.env['PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS'] = '30000';
    assert.equal(loadConfig().executionTimeoutMs, 30_000);
    for (const invalid of ['0', '600001', 'NaN']) {
      process.env['PI_OPS_PI_RUNTIME_EXECUTION_TIMEOUT_MS'] = invalid;
      assert.throws(() => loadConfig(), /must be an integer/);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
