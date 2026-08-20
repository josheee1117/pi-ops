import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateQueryRequest, ALLOWED_QUERY_TYPES } from '../evidence/types.js';
import {
  createDockerEvidenceProvider,
  decodeDockerLogs,
  type DockerClientLike,
} from '../evidence/docker.js';
import { makeNodeAgentConfig } from './test-config.js';

function makeConfig(overrides: Parameters<typeof makeNodeAgentConfig>[0] = {}) {
  return makeNodeAgentConfig({
    allowedContainers: new Set(['dataease', 'nginx']),
    ...overrides,
  });
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

  it('fails closed when the container allowlist is empty', () => {
    const result = validateQueryRequest(
      { type: 'docker.inspect', incidentId: 'inc-1', container: 'anything' },
      makeConfig({ allowedContainers: new Set() }),
    );
    assert.ok(!result.valid);
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

  it('accepts a bounded docker.logs since duration', () => {
    const result = validateQueryRequest(
      { type: 'docker.logs', incidentId: 'inc-1', container: 'dataease', since: '2m' },
      makeConfig(),
    );
    assert.ok(result.valid);
  });

  it('rejects an unbounded docker.logs since duration', () => {
    const result = validateQueryRequest(
      { type: 'docker.logs', incidentId: 'inc-1', container: 'dataease', since: '24h' },
      makeConfig(),
    );
    assert.ok(!result.valid);
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

  it('accepts host.disk with an allowlisted absolute path', () => {
    const result = validateQueryRequest(
      { type: 'host.disk', incidentId: 'inc-1', path: '/var' },
      makeConfig(),
    );
    assert.ok(result.valid);
  });

  it('rejects an absolute host.disk path outside the allowlist', () => {
    const result = validateQueryRequest(
      { type: 'host.disk', incidentId: 'inc-1', path: '/tmp;touch /tmp/pwned' },
      makeConfig(),
    );
    assert.ok(!result.valid);
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
      {
        type: 'http.probe',
        incidentId: 'inc-1',
        url: 'http://localhost:8080/health',
        timeout: 99999,
      },
      makeConfig({ probeMaxTimeoutMs: 30000 }),
    );
    assert.ok(!result.valid);
  });

  it('rejects an unconfigured public HTTP target', () => {
    const result = validateQueryRequest(
      { type: 'http.probe', incidentId: 'inc-1', url: 'https://example.com/' },
      makeConfig(),
    );
    assert.ok(!result.valid);
  });

  it('rejects an unconfigured metadata endpoint', () => {
    const result = validateQueryRequest(
      { type: 'http.probe', incidentId: 'inc-1', url: 'http://169.254.169.254/latest/meta-data/' },
      makeConfig(),
    );
    assert.ok(!result.valid);
  });

  it('rejects non-read-only HTTP methods', () => {
    const result = validateQueryRequest(
      {
        type: 'http.probe',
        incidentId: 'inc-1',
        url: 'http://localhost:8080/health',
        method: 'POST',
      },
      makeConfig(),
    );
    assert.ok(!result.valid);
  });

  it('accepts valid configured http.probe query', () => {
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

// ── Docker log provider ──────────────────────────────────────────────────────

function dockerFrame(streamType: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe('Docker log evidence', () => {
  it('decodes multiplexed stdout/stderr frames and enforces maxLines', () => {
    const raw = Buffer.concat([
      dockerFrame(1, 'first\n'),
      dockerFrame(2, 'second\n'),
      dockerFrame(1, 'third\n'),
    ]);
    const result = decodeDockerLogs(raw, 1024, 2);
    assert.deepEqual(result.lines, ['second', 'third']);
    assert.equal(result.truncated, true);
  });

  it('enforces the decoded payload byte cap', () => {
    const raw = dockerFrame(1, '1234567890\n');
    const result = decodeDockerLogs(raw, 5, 20);
    assert.deepEqual(result.lines, ['12345']);
    assert.equal(result.truncated, true);
  });

  it('applies bounded tail and since options at the Docker provider', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const client: DockerClientLike = {
      getContainer() {
        return {
          async inspect() { return {}; },
          async stats() { return {}; },
          async logs(options) {
            capturedOptions = options;
            return Buffer.concat([
              dockerFrame(1, 'line-one\n'),
              dockerFrame(2, 'line-two\n'),
            ]);
          },
        };
      },
    };
    const provider = createDockerEvidenceProvider(() => client);
    const before = Math.floor(Date.now() / 1000) - 120;
    const result = await provider.query({
      type: 'docker.logs',
      incidentId: 'inc-1',
      container: 'dataease',
      since: '2m',
      maxLines: 2,
    }, makeConfig());
    const after = Math.floor(Date.now() / 1000) - 120;

    assert.equal(capturedOptions?.['follow'], false);
    assert.equal(capturedOptions?.['tail'], 2);
    const since = capturedOptions?.['since'];
    assert.equal(typeof since, 'number');
    assert.ok((since as number) >= before && (since as number) <= after);
    assert.deepEqual(
      (result.data as { lines: string[] }).lines,
      ['line-one', 'line-two'],
    );
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