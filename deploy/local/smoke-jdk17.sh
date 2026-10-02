#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Unique SQLite directories preserve prior experiments and make each check repeatable.
export PI_OPS_JDK17_RUN_ID=${PI_OPS_JDK17_RUN_ID:-$(date +%Y%m%d-%H%M%S)}
COMPOSE=(docker compose -p pi-ops-jdk17-local -f "$ROOT/deploy/local/docker-compose.yml" -f "$ROOT/deploy/local/docker-compose.jdk17.yml" --env-file "$ROOT/deploy/local/compose.env" --env-file "$ROOT/deploy/local/.env.jdk17")
cleanup() {
  # Keep reports available, but do not keep forwarding unrelated local Docker events.
  "${COMPOSE[@]}" stop pi-ops-node-agent >/dev/null || true
  curl -fsS -X POST http://127.0.0.1:18089/ok >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "JDK17 local run=$PI_OPS_JDK17_RUN_ID (REAL model; five intended WeCom drill messages)"
# Stop observation first so replacing drill containers does not alert the group.
"${COMPOSE[@]}" stop pi-ops-node-agent pi-ops
"${COMPOSE[@]}" up -d --build
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const agent = 'http://127.0.0.1:18080';
const drill = 'http://127.0.0.1:18089';
const headers = { authorization: 'Bearer local-operator-token' };
const service = 'dataasset-jdk17-local-本地演练';
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  assert(response.ok, `HTTP ${response.status} on ${new URL(url).pathname}`);
  return response;
}
async function json(path) { return (await request(agent + path, { headers })).json(); }
async function until(label, check, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(2000);
  }
  throw new Error(`Timed out: ${label}`);
}
async function health(url) { try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }
async function incidents(type) { return (await json('/v1/ops/incidents')).incidents.filter(i => i.service === service && i.type === type); }
async function detail(id) { return json(`/v1/ops/incidents/${id}`); }
async function completed(id) {
  return until(`completed ${id}`, async () => {
    const d = await detail(id);
    const latest = d.sessions.at(-1);
    assert.notEqual(latest?.status, 'FAILED', `Investigation failed: ${id}`);
    return latest?.status === 'COMPLETED' ? d : null;
  }, 360000);
}
async function delivered(id, types) {
  return until(`WeCom delivery ${id}`, async () => {
    const d = await detail(id);
    for (const type of types) {
      const jobs = d.notifications.filter(j => j.type === type);
      assert(jobs.length <= 1, `Duplicate ${type}`);
      assert.notEqual(jobs[0]?.status, 'FAILED', `WeCom delivery failed: ${type}`);
      if (jobs[0]?.status !== 'DELIVERED') return null;
    }
    return d;
  });
}
await until('services ready', async () => (await health(agent + '/health')) && (await health(drill + '/health')));
const runtime = await (await request('http://127.0.0.1:18090/health')).json();
assert.equal(runtime.modelMode, 'REAL');
assert.notEqual(runtime.provider, 'fake');
console.log(`Runtime REAL ${runtime.provider}/${runtime.model}`);
assert.equal((await incidents('jvm.cpu_pressure')).length, 0, 'Use a fresh run directory');
await request(drill + '/cpu', { method: 'POST' });
const cpu = await until('JFR CPU incident', async () => (await incidents('jvm.cpu_pressure'))[0]);
const cpuDetail = await completed(cpu.id);
const evidence = (await json(`/v1/ops/incidents/${cpu.id}/evidence`)).evidence;
for (const kind of ['jfr.signal', 'docker.stats', 'host.load']) assert(evidence.some(e => e.kind === kind && e.status === 'succeeded'), `Missing ${kind}`);
const jfr = evidence.find(e => e.kind === 'jfr.signal');
assert.equal(jfr.data.semanticType, 'jvm.cpu_pressure');
assert.equal(typeof jfr.data.attributes.jvmUser, 'number');
const report = cpuDetail.sessions.at(-1).report;
assert(report.supportingEvidenceIds.includes(jfr.id) || report.contradictingEvidenceIds.includes(jfr.id), 'Report must cite observed JFR');
await delivered(cpu.id, ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED']);
console.log(`WHITEBOX PASS incident=${cpu.id} JFR + Docker + Host; report cites ${jfr.id}`);
console.log('hypothesis:', report.hypothesis);
assert.equal((await incidents('health.failure')).length, 0);
for (let i = 0; i < 3; i++) await request(drill + '/fail', { method: 'POST' });
const failure = await until('health incident', async () => (await incidents('health.failure'))[0]);
const healthDetail = await completed(failure.id);
for (const kind of ['http.probe', 'docker.inspect', 'docker.logs']) assert(healthDetail.evidence.some(e => e.kind === kind && e.status === 'succeeded'), `Missing ${kind}`);
await delivered(failure.id, ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED']);
await request(drill + '/ok', { method: 'POST' });
await until('recovered', async () => (await detail(failure.id)).incident.state === 'RECOVERED');
const recovered = await delivered(failure.id, ['INCIDENT_OPEN', 'INVESTIGATION_COMPLETED', 'INCIDENT_RECOVERED']);
assert.equal((await incidents('health.failure')).length, 1, 'Repeated failure must not create incidents');
assert.equal(recovered.sessions.length, 1, 'Repeated failure must not create investigations');
assert.equal(recovered.notifications.length, 3);
console.log(`BLACKBOX PASS incident=${failure.id} OPEN / COMPLETED / RECOVERED, no duplicates`);
console.log('JDK17 DOCKER + REAL MODEL + WECOM: PASS (WeCom errcode=0; human confirms group visibility)');
JS
