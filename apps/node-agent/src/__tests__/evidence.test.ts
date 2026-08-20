import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateQueryRequest, ALLOWED_QUERY_TYPES } from '../evidence/types.js';
import type { NodeAgentConfig } from '../config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<NodeAgentConfig> = {}): NodeAgentConfig {
  return {
    port: 0,
    nodeToken: 'test-token',
    nodeId: 'test-node',
    allowedContainers: new Set(['dataease', 'nginx']),
    dockerSocketPath: '/var/run/docker.sock',
    logsMaxLines: 200,
    logsMaxBytes: 1024 * 1024,
    probeMaxTimeoutMs: 30000,
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  };
}

// ── Query type validation ────────────────────────────────────────────────────

describe('validateQueryRequest', () => {
  it('rejects non-object body', () => {
    const result = validateQueryRequest('not-object', makeConfig());
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === 'body'));
    }
  });

  it('rejects null body', () => {
    const result = validateQueryRequest(null, makeConfig());
    assert.ok(!result.valid);
  });

  it('rejects unknown query type', () => {
    const result = validateQueryRequest(
      { type: 'unknown.query', incidentId: 'inc-1' },
      makeConfig(),
    );
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === 'type'));
    }
  });

  it('rejects missing incidentId', () => {
    const result = validateQueryRequest(
      { type: 'host.memory' },
      makeConfig(),
    );
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === 'incidentId'));
    }
  });

  it('accepts valid host.memory query', () => {
    const result = validateQueryRequest(
      { type: 'host.memory', incidentId: 'inc-1' },
      makeConfig(),
    );
    assert.ok(result.valid);
    if (result.valid) {
      assert.equal(result.request.type, 'host.memory');
      assert.equal(result.request.incidentId, 'inc-1');
    }
  });

  it('accepts valid host.load query', () => {
    const result = validateQueryRequest(
      { type: 'host.load', incidentId: 'inc-1' },
      makeConfig(),
    );
    assert.ok(result.valid);
  });

  // ── Docker queries ──────────────────────────────────────────────────────

  it('rejects docker query without container', () => {
    const result = validateQueryRequest(
      { type: 'docker.inspect', incidentId: 'inc-1' },
      makeConfig(),
    );
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === 'container'));
    }
  });

  it('rejects docker query with unlisted container', () => {
    const result = validateQueryRequest(
      { type: 'docker.inspect', incidentId: 'inc-1', container: 'unknown-container' },
      makeConfig(),
    );
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.message.includes('allowlist')));
    }
  });

  it('accepts docker query with allowlisted container', () => {
    const result = validateQueryRequest(
      { type: 'docker.inspect', incidentId: 'inc-1', container: 'dataease' },
      makeConfig(),
    );
    assert.ok(result.valid);
  });

  it('allows any container when allowlist is empty', () => {
    const result = validateQueryRequest(
      { type: 'docker.inspect', incidentId: 'inc-1', container: 'anything' },
      makeConfig({ allowedContainers: new Set() }),
    );
    assert.ok(result.valid);
  });

  it('rejects docker.logs with maxLines exceeding limit', () => {
    const result = validateQueryRequest(
      { type: 'docker.logs', incidentId: 'inc-1', container: 'dataease', maxLines: 9999 },
      makeConfig({ logsMaxLines: 200 }),
    );
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.message.includes('maxLines')));
    }
  });

  it('accepts docker.logs with valid maxLines', () => {
    const result = validateQueryRequest(
      { type: 'docker.logs', incidentId: 'inc-1', container: 'dataease', maxLines: 50 },
      makeConfig(),
    );
    assert.ok(result.valid);
    if (result.valid) {
      assert.equal(result.request.maxLines, 50);
    }
  });

  // ── Host disk ───────────────────────────────────────────────────────────

  it('rejects host.disk without path', () => {
    const result = validateQueryRequest(
      { type: 'host.disk', incidentId: 'inc-1' },
      makeConfig(),
    );
    assert.ok(!result.valid);
  });

  it('rejects host.disk with relative path', () => {
    const result = validateQueryRequest(
      { type: 'host.disk', incidentId: 'inc-1', path: 'relative/path' },
      makeConfig(),
    );
    assert.ok(!result.valid);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.message.includes('absolute')));
    }
  });

  it('accepts host.disk with absolute path', () => {
    const result = validateQueryRequest(
      { type: 'host.disk', incidentId: 'inc-1', path: '/var' },
      makeConfig(),
    );
    assert.ok(result.valid);
  });

  // ── HTTP probe ──────────────────────────────────────────────────────────

  it('rejects http.probe without url', () => {
    const result = validateQueryRequest(
      { type: 'http.probe', incidentId: 'inc-1' },
      makeConfig(),
    );
    assert.ok(!result.valid);
  });

  it('rejects http.probe with non-http URL', () => {
    const result = validateQueryRequest(
      { type: 'http.probe', incidentId: 'inc-1', url: 'ftp://example.com' },
      makeConfig(),
    );
    assert.ok(!result.valid);
  });

  it('rejects http.probe with invalid URL', () => {
    const result = validateQueryRequest(
      { type: 'http.probe', incidentId: 'inc-1', url: 'not-a-url' },
      makeConfig(),
    );
    assert.ok(!result.valid);
  });

  it('rejects http.probe with timeout exceeding max', () => {
    const result = validateQueryRequest(
      { type: 'http.probe', incidentId: 'inc-1', url: 'http://localhost:8080', timeout: 99999 },
      makeConfig({ probeMaxTimeoutMs: 30000 }),
    );
    assert.ok(!result.valid);
  });

  it('accepts valid http.probe query', () => {
    const result = validateQueryRequest(
      {
        type: 'http.probe',
        incidentId: 'inc-1',
        url: 'http://localhost:8080/health',
        method: 'GET',
        timeout: 5000,
      },
      makeConfig(),
    );
    assert.ok(result.valid);
    if (result.valid) {
      assert.equal(result.request.url, 'http://localhost:8080/health');
      assert.equal(result.request.method, 'GET');
      assert.equal(result.request.timeout, 5000);
    }
  });
});

// ── All query types are defined ──────────────────────────────────────────────

describe('query type registry', () => {
  it('all 7 required query types are registered', () => {
    const required = [
      'docker.inspect',
      'docker.logs',
      'docker.stats',
      'host.memory',
      'host.load',
      'host.disk',
      'http.probe',
    ];
    for (const t of required) {
      assert.ok(ALLOWED_QUERY_TYPES.has(t), `Missing query type: ${t}`);
    }
  });
});