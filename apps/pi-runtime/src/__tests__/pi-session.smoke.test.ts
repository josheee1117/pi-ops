import { describe, it } from 'node:test';

const enabled = process.env['PI_OPS_PI_RUNTIME_SMOKE'] === '1';

describe('optional Pi SDK smoke', () => {
  (enabled ? it : it.skip)('loads createAgentSession with noTools=all', async () => {
    const mod = await import('@earendil-works/pi-coding-agent');
    if (typeof mod.createAgentSession !== 'function') {
      throw new Error('createAgentSession is not available');
    }
  });
});
