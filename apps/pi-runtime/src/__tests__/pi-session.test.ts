import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertModelCompleted } from '../pi-session.js';

describe('pi session stop reason', () => {
  it('throws the upstream error message when the SDK stops on error', () => {
    assert.throws(() => assertModelCompleted('error', '429 rate limited'), {
      message: 'model upstream error: 429 rate limited',
    });
    assert.throws(() => assertModelCompleted('error', undefined), {
      message: 'model upstream error: unknown',
    });
  });

  it('leaves stop, length and aborted responses alone', () => {
    for (const stopReason of ['stop', 'length', 'aborted', undefined]) {
      assert.doesNotThrow(() => assertModelCompleted(stopReason, undefined));
    }
  });
});
