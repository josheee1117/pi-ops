import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createPortProbe, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpsEvent } from '@pi-ops/protocol';
import { makeAgentConfig } from './test-config.js';
import { createEvidenceOrchestrator } from '../evidence-orchestrator.js';
import { createIncidentEngine } from '../incident.js';
import { createEventStore } from '../store.js';

const NODE_AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node-agent');
const TOKEN = 'outage-node-token';
const STEP_TIMEOUT_MS = 15_000;

interface NodeAgentProcess {
  child: ChildProcess;
  output(): string;
}

async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function unusedPort(): Promise<number> {
  const server = createPortProbe();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** Local HTTP target. While holding, the request stays unanswered on purpose. */
async function startProbeTarget(): Promise<{
  url: string;
  received: Promise<void>;
  release(): void;
  close(): Promise<void>;
}> {
  let holding = true;
  const held: ServerResponse[] = [];
  let markReceived!: () => void;
  const received = new Promise<void>((done) => { markReceived = done; });
  const server: Server = createHttpServer((request, response) => {
    if (holding) {
      held.push(response);
      markReceived();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
  return {
    url,
    received,
    release() {
      holding = false;
      for (const response of held.splice(0)) response.destroy();
    },
    close() {
      for (const response of held.splice(0)) response.destroy();
      server.closeAllConnections();
      return new Promise<void>((done) => { server.close(() => done()); });
    },
  };
}

/**
 * One node process, not the tsx CLI: the CLI forks the script, so killing it
 * would leave the server running as an orphan.
 */
function startNodeAgent(port: number, probeUrl: string): NodeAgentProcess {
  let log = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: NODE_AGENT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PI_OPS_NODE_PORT: String(port),
      PI_OPS_NODE_TOKEN: TOKEN,
      PI_OPS_NODE_ID: 'outage-node',
      PI_OPS_HEALTH_TARGETS: JSON.stringify([{ name: 'outage-target', url: probeUrl, method: 'GET' }]),
      PI_OPS_LOG_SCAN_ENABLED: 'false',
      PI_OPS_DETECTOR_POLL_INTERVAL_MS: '3600000',
      PI_OPS_HEALTH_FAILURE_DURATION: '10000',
      PI_OPS_AGENT_URL: 'http://127.0.0.1:1',
    },
  });
  child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString(); });
  return { child, output: () => log };
}

async function waitForHealth(agent: NodeAgentProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (agent.child.exitCode !== null || agent.child.signalCode !== null) {
      throw new Error(`node agent exited before listening:\n${agent.output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      await response.body?.cancel().catch(() => {});
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`node agent did not become healthy:\n${agent.output()}`);
}

async function stop(agent: NodeAgentProcess | undefined): Promise<void> {
  if (!agent) return;
  const { child } = agent;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await withDeadline(once(child, 'exit').then(() => undefined), 5000, `node agent ${child.pid} did not exit`);
}

it('keeps a real Node Agent killed mid-collection retryable and never fabricates target health', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-outage-'));
  const store = createEventStore(join(dir, 'agent.sqlite'));
  const target = await startProbeTarget();
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let agent: NodeAgentProcess | undefined;
  try {
    agent = startNodeAgent(port, target.url);
    await waitForHealth(agent, baseUrl);

    const orchestrator = createEvidenceOrchestrator(makeAgentConfig({
      evidenceTimeoutMs: 15_000,
      nodeAgents: new Map([['outage-node', { nodeId: 'outage-node', url: baseUrl, token: TOKEN }]]),
    }), store);
    const event: OpsEvent = {
      schemaVersion: 1,
      id: 'evt-outage-1',
      time: '2026-10-26T12:00:00.000Z',
      source: 'health',
      nodeId: 'outage-node',
      service: 'outage-target',
      type: 'health.failure',
      severity: 'error',
      message: 'Health check failed for outage-target',
      attributes: { detector: 'http.health', target: 'outage-target', url: target.url, method: 'GET' },
    };
    const { incidentId } = createIncidentEngine(store, { aggregationWindowMs: 300_000 })
      .processEvent(event, event.time);
    assert.ok(incidentId);
    const incident = store.getIncident(incidentId);
    assert.ok(incident);

    // The request is inside the live node agent when the process disappears.
    const outageCollection = orchestrator.collectForIncident(incident, event, 'mid-collection');
    await withDeadline(target.received, STEP_TIMEOUT_MS, 'node agent never probed the target');
    await stop(agent);
    const outage = await withDeadline(outageCollection, STEP_TIMEOUT_MS, 'collection did not settle after the node agent died');

    assert.equal(outage.requested, 1);
    assert.equal(outage.succeeded, 0);
    assert.equal(outage.failed, 1);
    assert.equal(outage.retryableFailures, 1);
    assert.equal(outage.terminalFailures, 0);

    const failed = store.getEvidence('mid-collection-evidence-http.probe');
    assert.ok(failed);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureClass, 'retryable');
    assert.equal(failed.data, null);
    const failureText = failed.error;
    assert.ok(failureText);
    assert.doesNotMatch(failureText, /timed out/);
    for (const row of store.listEvidence(incident.id)) {
      assert.equal(row.kind, 'http.probe');
      assert.doesNotMatch(JSON.stringify(row), /"healthy"/);
    }
    await assert.rejects(fetch(`${baseUrl}/health`));

    target.release();
    agent = startNodeAgent(port, target.url);
    await waitForHealth(agent, baseUrl);
    const recovered = await withDeadline(
      orchestrator.collectForIncident(incident, event, 'mid-collection'),
      STEP_TIMEOUT_MS,
      'retry did not collect after the node agent restarted',
    );

    assert.equal(recovered.requested, 1);
    assert.equal(recovered.succeeded, 1);
    assert.equal(recovered.retryableFailures, 0);
    const collected = store.getEvidence('mid-collection-evidence-http.probe');
    assert.ok(collected);
    assert.equal(collected.status, 'succeeded');
    assert.equal(collected.failureClass, undefined);
    const data = collected.data as { healthy?: boolean; status?: number };
    assert.equal(data.healthy, true);
    assert.equal(data.status, 200);
  } finally {
    await stop(agent);
    await target.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
