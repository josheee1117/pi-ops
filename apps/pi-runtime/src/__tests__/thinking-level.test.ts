import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  UnsupportedThinkingLevelError,
  parseThinkingLevel,
  resolveRuntimeThinkingLevel,
} from '../thinking-level.js';

describe('Pi Runtime thinking level resolution', () => {
  it('H. production default stays off when the environment is unset', () => {
    assert.equal(resolveRuntimeThinkingLevel({}), 'off');
    assert.equal(parseThinkingLevel(undefined), 'off');
    assert.equal(DEFAULT_THINKING_LEVEL, 'off');
  });

  it('accepts exactly the SDK ThinkingLevel union', () => {
    assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const level of THINKING_LEVELS) {
      assert.equal(resolveRuntimeThinkingLevel({ PI_OPS_PI_THINKING_LEVEL: level }), level);
    }
  });

  it('rejects an unsupported level instead of silently falling back', () => {
    assert.throws(
      () => resolveRuntimeThinkingLevel({ PI_OPS_PI_THINKING_LEVEL: 'turbo' }),
      UnsupportedThinkingLevelError,
    );
    assert.throws(
      () => resolveRuntimeThinkingLevel({ PI_OPS_PI_THINKING_LEVEL: 'HIGH' }),
      /unsupported thinking level: HIGH/,
    );
    assert.equal(parseThinkingLevel(''), 'off');
  });

  it('treats an empty value as unset so CI can pass an empty variable', () => {
    assert.equal(resolveRuntimeThinkingLevel({ PI_OPS_PI_THINKING_LEVEL: '' }), 'off');
  });
});
