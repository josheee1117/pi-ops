#!/usr/bin/env node
// Control CLI for the local pi-ops compose stack. Every command prints one JSON object on stdout.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const LOCAL = join(ROOT, 'deploy/local');
const COMPOSE = ['compose', '-f', join(LOCAL, 'docker-compose.yml'), '--env-file', join(LOCAL, 'compose.env')];
const URLS = {
  agent: process.env.PI_OPS ?? 'http://127.0.0.1:18080',
  node: process.env.NODE_URL ?? 'http://127.0.0.1:18081',
  runtime: process.env.RUNTIME_URL ?? 'http://127.0.0.1:18090',
  drill: process.env.DRILL ?? 'http://127.0.0.1:18088',
  sink: process.env.SINK ?? 'http://127.0.0.1:18099',
};
const OPERATOR = process.env.OPERATOR ?? 'local-operator-token';
const NODE_TOKEN = process.env.NODE_TOKEN ?? 'local-node-token';
const RUNTIME = process.env.RUNTIME ?? 'local-runtime-token';
const EVIDENCE_ROOT = join(ROOT, 'artifacts/verify-pi-ops');

const HELP = `control-pi-ops — drive the local pi-ops compose stack (deploy/local) for verification.

Usage: node .cursor/skills/verify-pi-ops/scripts/control-pi-ops.mjs <command> [options]

Lifecycle
  up [--dry-run]            Wipe deploy/local/data, build and start the stack, wait until all 5 services answer /health.
  doctor                    Read-only: containers, health of every service, operator/node/runtime auth. Exit 1 if unhealthy.
  down [--dry-run]          Stop and remove the stack's containers and deploy/local/data. Never touches artifacts/.

Drive (the same HTTP calls an operator or a node makes)
  drill <fail|ok>           Flip the drill service's /health (simulates an outage / recovery).
  incidents                 GET /v1/ops/incidents (operator token).
  incident <id>             GET /v1/ops/incidents/<id>: incident, sessions, notifications.
  evidence <id> [--view safe|raw]   GET /v1/ops/incidents/<id>/evidence.
  wait-incident [--service pi-ops-drill] [--state OPEN|RECOVERED] [--timeout 90]
                            Poll until a health.failure incident for the service reaches the state.
  wait-session <id> [--timeout 120]  Poll until the incident's first investigation session is COMPLETED or FAILED.
  notifications             GET the notification sink's received webhooks (mock of WeCom/generic webhook).
  node-evidence <type>      POST node-agent /v1/evidence/query (e.g. host.memory, host.load).

Evidence
  save <run-id> <name> -- <command...>   Run another control-pi-ops command and write its JSON to
                            artifacts/verify-pi-ops/<run-id>/<name>.json (survives 'down').

Env overrides: PI_OPS NODE_URL RUNTIME_URL DRILL SINK OPERATOR NODE_TOKEN RUNTIME (defaults = local compose).
Exit codes: 0 ok, 1 check failed, 2 usage error.`;

const out = (obj, code = 0) => { console.log(JSON.stringify(obj, null, 2)); process.exit(code); };
const fail = (error, hint, code = 1) => out({ ok: false, error, hint }, code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (args, name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

async function http(url, { method = 'GET', token, body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, ok: res.ok, body: json };
  } catch (e) {
    return { status: 0, ok: false, body: String(e.cause?.code ?? e.message) };
  }
}

// Containers write deploy/local/data as root, so a host-side rm can hit EACCES; fall back to
// deleting from inside a throwaway container built from this stack's own sink image.
function wipeData(subdirs) {
  const data = join(LOCAL, 'data');
  try { for (const d of subdirs) rmSync(join(data, d), { recursive: true, force: true }); }
  catch {
    const targets = subdirs.map((d) => `/d/${d}`).join(' ');
    const r = spawnSync('docker', ['run', '--rm', '-v', `${data}:/d`, '--entrypoint', 'sh', 'pi-ops-local-notification-sink', '-c', `rm -rf ${targets}`], { encoding: 'utf8' });
    if (r.status !== 0) fail(`could not remove ${data}`, 'Files are root-owned by the containers. Remove them with sudo, or build the stack once so the sink image exists.', 1);
  }
}

const docker = (args) => spawnSync('docker', [...COMPOSE, ...args], { encoding: 'utf8' });

async function doctor() {
  const ps = docker(['ps', '--format', 'json']);
  if (ps.error || ps.status !== 0) return { ok: false, error: 'docker compose ps failed', hint: 'Is dockerd running and is the socket readable? Try `docker info`.', detail: ps.stderr };
  const containers = ps.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => ({ service: c.Service, state: c.State, health: c.Health }));
  const checks = {
    'pi-ops /health': await http(`${URLS.agent}/health`),
    'pi-ops operator auth': await http(`${URLS.agent}/v1/ops/incidents`, { token: OPERATOR }),
    'node-agent /health': await http(`${URLS.node}/health`),
    'node-agent evidence auth': await http(`${URLS.node}/v1/evidence/query`, { method: 'POST', token: NODE_TOKEN, body: { type: 'host.load', incidentId: 'inc-doctor' } }),
    'pi-runtime /ready': await http(`${URLS.runtime}/ready`, { token: RUNTIME }),
    'drill /health reachable': await http(`${URLS.drill}/health`),
    'sink /health': await http(`${URLS.sink}/health`),
  };
  const summary = Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, k.startsWith('drill') ? v.status !== 0 : v.ok]));
  const missing = ['pi-ops', 'pi-ops-node-agent', 'pi-runtime', 'pi-ops-drill', 'notification-sink'].filter((s) => !containers.some((c) => c.service === s && c.state === 'running'));
  return { ok: missing.length === 0 && Object.values(summary).every(Boolean), project: 'pi-ops-local', missingServices: missing, containers, checks: summary,
    drillHealthy: checks['drill /health reachable'].status === 200,
    hint: missing.length ? 'Run `control-pi-ops up`. If containers run but checks fail, see Gotchas in SKILL.md (bridge networking).' : undefined };
}

async function waitHealthy(timeoutS = 180) {
  const end = Date.now() + timeoutS * 1000;
  let last;
  while (Date.now() < end) { last = await doctor(); if (last.ok) return last; await sleep(2000); }
  return last;
}

const [cmd, ...args] = process.argv.slice(2);
const dry = args.includes('--dry-run');
switch (cmd) {
  case undefined: case '-h': case '--help': case 'help':
    console.log(HELP); process.exit(cmd ? 0 : 2);
  case 'up': {
    const plan = [`docker ${COMPOSE.join(' ')} down`, `rm -rf ${LOCAL}/data/pi-ops ${LOCAL}/data/pi-runtime ${LOCAL}/data/notifications`, `docker ${COMPOSE.join(' ')} up -d --build`];
    if (dry) out({ ok: true, dryRun: true, wouldRun: plan });
    docker(['down']);
    wipeData(['pi-ops', 'pi-runtime', 'notifications']);
    for (const d of ['pi-ops', 'pi-runtime', 'notifications']) mkdirSync(join(LOCAL, 'data', d), { recursive: true });
    const up = docker(['up', '-d', '--build']);
    if (up.status !== 0) fail('docker compose up failed', 'Read the stderr tail; a port in 18080-18099 may be taken by another instance.', 1);
    const d = await waitHealthy();
    out({ ok: d.ok, ran: plan, doctor: d }, d.ok ? 0 : 1);
  }
  case 'down': {
    const plan = [`docker ${COMPOSE.join(' ')} down --remove-orphans`, `rm -rf ${LOCAL}/data`];
    if (dry) out({ ok: true, dryRun: true, wouldRun: plan, keeps: EVIDENCE_ROOT });
    const r = docker(['down', '--remove-orphans']);
    wipeData(['pi-ops', 'pi-runtime', 'notifications']);
    rmSync(join(LOCAL, 'data'), { recursive: true, force: true });
    out({ ok: r.status === 0, ran: plan, evidenceKeptAt: EVIDENCE_ROOT, evidenceExists: existsSync(EVIDENCE_ROOT) }, r.status === 0 ? 0 : 1);
  }
  case 'doctor': { const d = await doctor(); out(d, d.ok ? 0 : 1); }
  case 'drill': {
    if (!['fail', 'ok'].includes(args[0])) fail('drill needs fail or ok', 'e.g. `control-pi-ops drill fail`', 2);
    const r = await http(`${URLS.drill}/${args[0]}`, { method: 'POST' });
    out({ ok: r.ok, drill: r.body }, r.ok ? 0 : 1);
  }
  case 'incidents': { const r = await http(`${URLS.agent}/v1/ops/incidents`, { token: OPERATOR }); out({ ok: r.ok, status: r.status, ...(typeof r.body === 'object' ? r.body : { body: r.body }) }, r.ok ? 0 : 1); }
  case 'incident': case 'evidence': {
    if (!args[0] || args[0].startsWith('--')) fail(`${cmd} needs an incident id`, 'Get one from `control-pi-ops incidents` or `wait-incident`.', 2);
    const view = flag(args, '--view', 'safe');
    const url = cmd === 'incident' ? `${URLS.agent}/v1/ops/incidents/${args[0]}` : `${URLS.agent}/v1/ops/incidents/${args[0]}/evidence?view=${view}`;
    const r = await http(url, { token: OPERATOR });
    out({ ok: r.ok, status: r.status, ...(typeof r.body === 'object' ? r.body : { body: r.body }) }, r.ok ? 0 : 1);
  }
  case 'wait-incident': {
    const service = flag(args, '--service', 'pi-ops-drill');
    const state = flag(args, '--state', 'OPEN');
    const end = Date.now() + Number(flag(args, '--timeout', '90')) * 1000;
    while (Date.now() < end) {
      const r = await http(`${URLS.agent}/v1/ops/incidents`, { token: OPERATOR });
      const hit = (r.body?.incidents ?? []).filter((i) => i.type === 'health.failure' && i.service === service && i.state === state).at(-1);
      if (hit) out({ ok: true, incident: hit });
      await sleep(2000);
    }
    fail(`no health.failure incident for ${service} in state ${state}`, 'Did you run `drill fail`? Check `docker compose logs pi-ops-node-agent` for "event push failed".');
  }
  case 'wait-session': {
    if (!args[0]) fail('wait-session needs an incident id', 'e.g. `control-pi-ops wait-session inc-...`', 2);
    const end = Date.now() + Number(flag(args, '--timeout', '120')) * 1000;
    let last;
    while (Date.now() < end) {
      last = (await http(`${URLS.agent}/v1/ops/incidents/${args[0]}`, { token: OPERATOR })).body;
      const s = last?.sessions?.[0];
      if (s && ['COMPLETED', 'FAILED'].includes(s.status)) out({ ok: s.status === 'COMPLETED', session: s }, s.status === 'COMPLETED' ? 0 : 1);
      await sleep(3000);
    }
    fail('investigation session did not finish', 'Check `docker compose logs pi-runtime pi-ops`.');
  }
  case 'notifications': { const r = await http(`${URLS.sink}/notifications`); out({ ok: r.ok, ...(typeof r.body === 'object' ? r.body : { body: r.body }) }, r.ok ? 0 : 1); }
  case 'node-evidence': {
    if (!args[0]) fail('node-evidence needs a type', 'e.g. host.memory, host.load, docker.inspect', 2);
    const r = await http(`${URLS.node}/v1/evidence/query`, { method: 'POST', token: NODE_TOKEN, body: { type: args[0], incidentId: 'inc-verify', ...(flag(args, '--container') ? { container: flag(args, '--container') } : {}) } });
    out({ ok: r.ok, status: r.status, ...(typeof r.body === 'object' ? r.body : { body: r.body }) }, r.ok ? 0 : 1);
  }
  case 'save': {
    const [run, name, sep, ...rest] = args;
    if (!run || !name || sep !== '--' || !rest.length) fail('usage: save <run-id> <name> -- <command...>', 'e.g. `save run1 incident -- incident inc-123`', 2);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...rest], { encoding: 'utf8' });
    const dir = join(EVIDENCE_ROOT, run); mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ command: ['control-pi-ops', ...rest].join(' '), exitCode: r.status, capturedAt: new Date().toISOString(), stdout: (() => { try { return JSON.parse(r.stdout); } catch { return r.stdout; } })(), stderr: r.stderr }, null, 2));
    out({ ok: r.status === 0, saved: file, exitCode: r.status }, r.status === 0 ? 0 : 1);
  }
  default:
    fail(`unknown command: ${cmd}`, 'Run with --help for the command list.', 2);
}
