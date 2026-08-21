import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';

const CONFIG_KEYS = [
  'PI_OPS_NODE_TOKEN',
  'PI_OPS_NODE_PORT',
  'PI_OPS_LOGS_MAX_LINES',
  'PI_OPS_LOGS_MAX_BYTES',
  'PI_OPS_DOCKER_QUERY_TIMEOUT_MS',
  'PI_OPS_PROBE_MAX_TIMEOUT_MS',
  'PI_OPS_MAX_RESPONSE_BYTES',
  'PI_OPS_NODE_MAX_REQUEST_BYTES',
  'PI_OPS_EVENT_QUEUE_SIZE',
  'PI_OPS_EVENT_SEND_TIMEOUT_MS',
  'PI_OPS_EVENT_MAX_RETRIES',
  'PI_OPS_EVENT_FLUSH_INTERVAL_MS',
  'PI_OPS_DOCKER_REPLAY_LOOKBACK_SECONDS',
  'PI_OPS_DETECTOR_POLL_INTERVAL_MS',
  'PI_OPS_MEMORY_PRESSURE_THRESHOLD',
  'PI_OPS_MEMORY_PRESSURE_DURATION',
  'PI_OPS_DISK_PRESSURE_THRESHOLD',
  'PI_OPS_DISK_PRESSURE_DURATION',
  'PI_OPS_HEALTH_FAILURE_DURATION',
  'PI_OPS_HEALTH_TARGETS',
] as const;

function withConfigEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of CONFIG_KEYS) previous.set(key, process.env[key]);
  try {
    for (const key of CONFIG_KEYS) delete process.env[key];
    process.env['PI_OPS_NODE_TOKEN'] = 'node-token';
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

describe('Node Agent loadConfig numeric validation', () => {
  it('accepts strict bounded numeric values', () => {
    withConfigEnv({
      PI_OPS_NODE_PORT: '8081',
      PI_OPS_LOGS_MAX_LINES: '200',
      PI_OPS_MEMORY_PRESSURE_THRESHOLD: '0.9',
      PI_OPS_DISK_PRESSURE_THRESHOLD: '1',
      PI_OPS_EVENT_MAX_RETRIES: '0',
      PI_OPS_DOCKER_REPLAY_LOOKBACK_SECONDS: '300',
    }, () => {
      const config = loadConfig();
      assert.equal(config.port, 8081);
      assert.equal(config.logsMaxLines, 200);
      assert.equal(config.memoryPressureThreshold, 0.9);
      assert.equal(config.diskPressureThreshold, 1);
      assert.equal(config.eventMaxRetries, 0);
      assert.equal(config.dockerReplayLookbackSeconds, 300);
    });
  });

  it('fails fast for malformed, NaN, fractional, negative, and out-of-range values', () => {
    const invalidValues: Array<[string, string]> = [
      ['PI_OPS_NODE_PORT', '123abc'],
      ['PI_OPS_NODE_PORT', '0'],
      ['PI_OPS_NODE_PORT', '65536'],
      ['PI_OPS_LOGS_MAX_LINES', 'NaN'],
      ['PI_OPS_LOGS_MAX_BYTES', '-1'],
      ['PI_OPS_DOCKER_QUERY_TIMEOUT_MS', '1.5'],
      ['PI_OPS_PROBE_MAX_TIMEOUT_MS', '0'],
      ['PI_OPS_MAX_RESPONSE_BYTES', 'Infinity'],
      ['PI_OPS_NODE_MAX_REQUEST_BYTES', ' 1024'],
      ['PI_OPS_EVENT_QUEUE_SIZE', '+10'],
      ['PI_OPS_EVENT_SEND_TIMEOUT_MS', '-500'],
      ['PI_OPS_EVENT_MAX_RETRIES', '-1'],
      ['PI_OPS_EVENT_FLUSH_INTERVAL_MS', '1000ms'],
      ['PI_OPS_DOCKER_REPLAY_LOOKBACK_SECONDS', '0'],
      ['PI_OPS_DOCKER_REPLAY_LOOKBACK_SECONDS', '86401'],
      ['PI_OPS_DETECTOR_POLL_INTERVAL_MS', '0'],
      ['PI_OPS_MEMORY_PRESSURE_DURATION', '2.5'],
      ['PI_OPS_DISK_PRESSURE_DURATION', ''],
      ['PI_OPS_HEALTH_FAILURE_DURATION', '10001'],
      ['PI_OPS_MEMORY_PRESSURE_THRESHOLD', 'NaN'],
      ['PI_OPS_MEMORY_PRESSURE_THRESHOLD', '-0.1'],
      ['PI_OPS_MEMORY_PRESSURE_THRESHOLD', '1.1'],
      ['PI_OPS_DISK_PRESSURE_THRESHOLD', '0'],
      ['PI_OPS_DISK_PRESSURE_THRESHOLD', '0.9garbage'],
    ];

    for (const [key, value] of invalidValues) {
      withConfigEnv({ [key]: value }, () => {
        assert.throws(() => loadConfig(), new RegExp(key));
      });
    }
  });

  it('rejects non-integer or out-of-range health target intervals', () => {
    for (const intervalMs of [0, -1, 1.5, 3_600_001, Number.NaN]) {
      withConfigEnv({
        PI_OPS_HEALTH_TARGETS: JSON.stringify([
          { name: 'api', url: 'http://localhost/health', intervalMs },
        ]),
      }, () => {
        assert.throws(() => loadConfig(), /bounded positive integer/);
      });
    }
  });
});
