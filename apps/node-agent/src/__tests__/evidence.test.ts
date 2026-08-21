import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateQueryRequest, ALLOWED_QUERY_TYPES } from '../evidence/types.js';
import {
  createDockerEvidenceProvider,
  decodeDockerLogs,
  fetchDockerJson,
  fetchDockerLogs,
  type DockerJsonFetcher,
  type DockerLogFetcher,
  type DockerLogOptions,
} from '../evidence/docker.js';
import { createProbeEvidenceProvider } from '../evidence/probe.js';
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

  it('accepts a bounded absolute docker.logs since/until window', () => {
    const result = validateQueryRequest(
      {
        type: 'docker.logs',
        incidentId: 'inc-1',
        container: 'dataease',
        since: '2026-08-20T11:58:00.000Z',
        until: '2026-08-20T12:02:00.000Z',
      },
      makeConfig(),
    );
    assert.ok(result.valid);
    if (result.valid) {
      assert.equal(result.request.since, '2026-08-20T11:58:00.000Z');
      assert.equal(result.request.until, '2026-08-20T12:02:00.000Z');
    }
  });

  it('rejects an absolute docker.logs since without until', () => {
    const result = validateQueryRequest(
      {
        type: 'docker.logs',
        incidentId: 'inc-1',
        container: 'dataease',
        since: '2026-08-20T11:58:00.000Z',
      },
      makeConfig(),
    );
    assert.ok(!result.valid);
  });

  it('rejects an absolute docker.logs window longer than 1h', () => {
    const result = validateQueryRequest(
      {
        type: 'docker.logs',
        incidentId: 'inc-1',
        container: 'dataease',
        since: '2026-08-20T10:00:00.000Z',
        until: '2026-08-20T12:00:00.000Z',
      },
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

// ── HTTP probe provider ──────────────────────────────────────────────────────

describe('HTTP probe evidence', () => {
  it('completes from status headers without buffering a never-ending body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const interval = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 10);
      res.on('close', () => clearInterval(interval));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}/health`;

    try {
      const query = createProbeEvidenceProvider().query(
        { type: 'http.probe', incidentId: 'inc-1', url, method: 'GET', timeout: 5000 },
        makeConfig(),
      );
      const result = await Promise.race([
        query,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('probe buffered the response body')), 500),
        ),
      ]);
      assert.equal((result.data as { status: number }).status, 200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

  it('stops a Docker socket response at the raw byte limit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-ops-docker-logs-'));
    const socketPath = join(directory, 'docker.sock');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(1024, 'x'));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      const result = await fetchDockerLogs(
        makeConfig({ dockerSocketPath: socketPath, dockerQueryTimeoutMs: 1000 }),
        'dataease',
        { maxLines: 200 },
        64,
      );
      assert.equal(result.buffer.length, 64);
      assert.equal(result.truncated, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects oversized Docker inspect/stats JSON before parsing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-ops-docker-json-'));
    const socketPath = join(directory, 'docker.sock');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ payload: 'x'.repeat(1024) }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    try {
      await assert.rejects(
        () => fetchDockerJson(
          makeConfig({ dockerSocketPath: socketPath, dockerQueryTimeoutMs: 1000 }),
          '/containers/dataease/json',
          64,
        ),
        /exceeds 64 bytes/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps OOM-safe inspect fields and excludes Env and mount secrets', async () => {
    const jsonFetcher: DockerJsonFetcher = async () => ({
      Id: 'container-id',
      Name: '/dataease',
      RestartCount: 4,
      State: {
        Status: 'exited',
        Running: false,
        StartedAt: '2026-08-20T12:00:00.000Z',
        OOMKilled: true,
        ExitCode: 137,
        Health: { Status: 'unhealthy', Log: [{ Output: 'token=secret' }] },
      },
      HostConfig: { Memory: 536_870_912, Binds: ['/secret:/run/secret'] },
      Config: { Image: 'dataease:latest', Env: ['TOKEN=secret'] },
      Mounts: [{ Source: '/host/secret', Destination: '/run/secret' }],
    });
    const provider = createDockerEvidenceProvider(jsonFetcher);

    const result = await provider.query({
      type: 'docker.inspect',
      incidentId: 'inc-oom',
      container: 'dataease',
    }, makeConfig());
    const data = result.data as Record<string, unknown>;
    const state = data['State'] as Record<string, unknown>;
    const health = state['Health'] as Record<string, unknown>;
    const hostConfig = data['HostConfig'] as Record<string, unknown>;
    const imageConfig = data['Config'] as Record<string, unknown>;

    assert.equal(state['OOMKilled'], true);
    assert.equal(state['ExitCode'], 137);
    assert.equal(data['RestartCount'], 4);
    assert.equal(health['Status'], 'unhealthy');
    assert.equal(hostConfig['Memory'], 536_870_912);
    assert.equal(imageConfig['Image'], 'dataease:latest');
    assert.equal('Env' in imageConfig, false);
    assert.equal('Mounts' in data, false);
    assert.equal('Binds' in hostConfig, false);
    assert.doesNotMatch(JSON.stringify(data), /TOKEN|secret/);
  });

  it('applies bounded tail, bytes, and since options at the Docker provider', async () => {
    let capturedOptions: DockerLogOptions | undefined;
    let capturedRawLimit: number | undefined;
    const jsonFetcher: DockerJsonFetcher = async () => ({});
    const logFetcher: DockerLogFetcher = async (_config, _container, options, rawLimit) => {
      capturedOptions = options;
      capturedRawLimit = rawLimit;
      return {
        buffer: Buffer.concat([
          dockerFrame(1, 'line-one\n'),
          dockerFrame(2, 'line-two\n'),
        ]),
        truncated: false,
      };
    };
    const provider = createDockerEvidenceProvider(jsonFetcher, logFetcher);
    const config = makeConfig({ logsMaxBytes: 100 });
    const before = Math.floor(Date.now() / 1000) - 120;
    const result = await provider.query({
      type: 'docker.logs',
      incidentId: 'inc-1',
      container: 'dataease',
      since: '2m',
      maxLines: 2,
    }, config);
    const after = Math.floor(Date.now() / 1000) - 120;

    assert.equal(capturedOptions?.maxLines, 2);
    const since = capturedOptions?.since;
    assert.equal(typeof since, 'number');
    assert.ok((since as number) >= before && (since as number) <= after);
    assert.equal(capturedRawLimit, 116); // 100 payload bytes + 2 multiplex headers
    assert.deepEqual(
      (result.data as { lines: string[] }).lines,
      ['line-one', 'line-two'],
    );
  });

  it('forwards an absolute event-time window to Docker instead of collection time', async () => {
    let capturedOptions: DockerLogOptions | undefined;
    const logFetcher: DockerLogFetcher = async (_config, _container, options) => {
      capturedOptions = options;
      return { buffer: dockerFrame(1, 'line\n'), truncated: false };
    };
    const provider = createDockerEvidenceProvider(async () => ({}), logFetcher);
    await provider.query({
      type: 'docker.logs',
      incidentId: 'inc-1',
      container: 'dataease',
      since: '2026-08-20T11:58:00.000Z',
      until: '2026-08-20T12:02:00.000Z',
      maxLines: 20,
    }, makeConfig());

    assert.equal(capturedOptions?.since, Date.parse('2026-08-20T11:58:00.000Z') / 1000);
    assert.equal(capturedOptions?.until, Date.parse('2026-08-20T12:02:00.000Z') / 1000);
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