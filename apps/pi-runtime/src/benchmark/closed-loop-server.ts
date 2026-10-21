import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import type { BenchmarkCase } from './fixtures.js';

/**
 * Seeds a real agent process (store + app + brief endpoint) with one
 * benchmark case and renders the WeCom message from the stored report.
 *
 * Nothing leaves the machine: the detail URL points at 127.0.0.1 and the
 * WeCom notifier uses a capturing fetch instead of the webhook.
 */

export interface StoredEvidence {
  id: string;
  incidentId: string;
  nodeId: string;
  source: string;
  kind: string;
  collectedAt: string;
  status: 'succeeded' | 'failed';
  data: unknown;
}

export interface CaseAgentServer {
  incidentId: string;
  detailUrl: string;
  operatorToken: string;
  message: string;
  detailMarkdown: string;
  detailBytes: number;
  evidenceCount: number;
  close(): Promise<void>;
}

async function agentModule(name: string) {
  return import(new URL(`../../../agent/src/${name}.ts`, import.meta.url).href);
}

async function callJson(url: string, token: string, body: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* keep text for the error */ }
  if (response.status >= 300) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 2000)}`);
  return { status: response.status, text, json };
}

export async function openCaseAgentServer(
  benchmarkCase: BenchmarkCase,
  report: unknown,
  evidence: StoredEvidence[],
): Promise<CaseAgentServer> {
  const raw = benchmarkCase.rawIncident;
  if (!raw) throw new Error('raw incident required');
  const { createEventStore } = await agentModule('store');
  const { createApp } = await agentModule('app');
  const { createIncidentEngine } = await agentModule('incident');
  const { createInvestigationLoopService } = await agentModule('investigation-loop');
  const { makeAgentConfig } = await agentModule('__tests__/test-config');
  const { createWeComNotifier } = await agentModule('notifier');
  const { buildNotificationPayload, incidentFactsFromRow } = await agentModule('notification');

  const directory = mkdtempSync(join(tmpdir(), 'closed-loop-'));
  const sqlitePath = join(directory, 'agent.sqlite');
  const store = createEventStore(sqlitePath);
  const config = makeAgentConfig({ sqlitePath, piRuntimeToken: 'runtime-token' });
  const loop = createInvestigationLoopService(store);
  const app = createApp(config, store, createIncidentEngine(store, config), undefined, loop);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP listener');
  const base = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  };

  try {
    const incident = store.createIncident({
      service: raw.service, node_id: raw.node_id, type: raw.type, state: raw.state,
      fingerprint: raw.fingerprint, first_seen: raw.first_seen, last_seen: raw.last_seen,
      event_count: raw.event_count, severity: raw.severity,
    });
    for (const item of evidence) store.insertEvidence({ ...item, incidentId: incident.id });

    const started = await callJson(`${base}/v1/ops/investigations`, config.operatorToken, { incidentId: incident.id });
    const sessionId = String(started.json['sessionId'] ?? '');
    const runtimeRequestId = String(started.json['runtimeRequestId'] ?? '');
    if (!sessionId || !runtimeRequestId) throw new Error('investigation start returned no session');
    await callJson(`${base}/v1/investigation-results`, 'runtime-token', {
      schemaVersion: 1,
      runtimeRequestId,
      runtimeTaskId: `rt-${runtimeRequestId}`,
      sessionId,
      status: 'completed',
      report,
    });

    const stored = store.getInvestigationReportBySessionId(sessionId);
    if (!stored) throw new Error('investigation report was not stored');

    const detailUrl = `${base}/v1/ops/incidents/${encodeURIComponent(incident.id)}/brief?format=markdown`;
    const detailResponse = await fetch(detailUrl, { headers: { Authorization: `Bearer ${config.operatorToken}` } });
    if (detailResponse.status !== 200) throw new Error(`detail endpoint returned ${detailResponse.status}: ${(await detailResponse.text()).slice(0, 2000)}`);
    const detailMarkdown = await detailResponse.text();

    let message = '';
    const notifier = createWeComNotifier({
      webhookUrl: 'https://capture.invalid/no-network', detailsBaseUrl: base,
      timeoutMs: 1000, maxResponseBytes: 128,
      fetch: async (_url: unknown, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('expected string notification body');
        const body = JSON.parse(init.body) as { markdown?: { content?: unknown } };
        if (typeof body.markdown?.content !== 'string') throw new Error('invalid rendered message');
        message = body.markdown.content;
        return new Response(JSON.stringify({ errcode: 0 }));
      },
    });
    const payload = buildNotificationPayload({
      notificationId: `closed-loop-${incident.id}`, type: 'INVESTIGATION_COMPLETED',
      incident: incidentFactsFromRow(incident), evidenceIds: store.listEvidence(incident.id).map((item: { id: string }) => item.id),
      analysis: { ...stored, investigationSessionId: stored.sessionId, reasoningResultId: stored.id },
    });
    payload.summarySeverity = store.getSummarySeverity(incident.id);
    await notifier.send(payload);
    if (!message) throw new Error('notification was not captured');

    return {
      incidentId: incident.id, detailUrl, operatorToken: config.operatorToken,
      message, detailMarkdown, detailBytes: Buffer.byteLength(detailMarkdown),
      evidenceCount: store.listEvidence(incident.id).length, close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
