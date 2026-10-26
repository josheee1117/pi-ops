import { validateRuntimeInvestigationContext, validateRuntimeEvidenceResponse, type RuntimeInvestigationContext, type RuntimeEvidenceResponse, type RuntimeInvestigationReportInput } from '@pi-ops/protocol';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criteriaFor, type ClosedLoopCriteria } from './closed-loop-cases.js';
import type { RuntimeEvidenceClient } from '../evidence-client.js';
import type { BenchmarkCase, BenchmarkEvidence } from './fixtures.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// Dynamic imports keep the benchmark-only agent dependency outside runtime's production rootDir.
async function agentModule(name: string) {
  return import(new URL(`../../../agent/src/${name}.ts`, import.meta.url).href);
}

/** Fixture directories from the pre-written criteria, keyed by the Incident service. */
export function sourceRootsFor(benchmarkCase: BenchmarkCase): Record<string, string> {
  if (!benchmarkCase.rawIncident) return {};
  let criteria: ClosedLoopCriteria;
  try {
    criteria = criteriaFor(benchmarkCase.id);
  } catch {
    return {};
  }
  const roots: Record<string, string> = {};
  for (const item of criteria.sources) {
    roots[benchmarkCase.rawIncident.service] = dirname(resolve(REPO_ROOT, item.path));
  }
  return roots;
}

export async function projectCase(benchmarkCase: BenchmarkCase): Promise<RuntimeInvestigationContext> {
  if (!benchmarkCase.rawIncident) throw new Error('raw incident required');
  const { buildIncidentContext } = await agentModule('incident-context');
  const { sourceSnippetEvidence } = await agentModule('source-snippet');
  const snippet = sourceSnippetEvidence({
    incident: benchmarkCase.rawIncident,
    evidence: benchmarkCase.evidence,
    roots: sourceRootsFor(benchmarkCase),
    collectedAt: benchmarkCase.collectedAt,
  });
  const evidence = snippet ? [...benchmarkCase.evidence, snippet] : benchmarkCase.evidence;
  const projected = buildIncidentContext(benchmarkCase.rawIncident, evidence, {
    maxEvidenceItems: 8, maxContextBytes: 8192, maxLogLines: 20,
  });
  const parsed = validateRuntimeInvestigationContext({
    schemaVersion: 1, ...projected,
    historicalKnowledgeStatus: 'unavailable',
    historicalKnowledge: { similarIncidents: [], historicalHypotheses: [], previousResolutions: [], relatedMemories: [] },
    conflictingMemories: [],
  });
  if (!parsed.success) throw new Error(parsed.message);
  return parsed.value;
}

export async function withoutSourceSnippetBodies<T>(value: T, evidence: readonly unknown[] = []): Promise<T> {
  const { withoutSourceSnippetText } = await agentModule('incident-context');
  const bodies = new Set<string>();
  const collect = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if ('kind' in item && item.kind === 'source.snippet' && 'data' in item
      && item.data && typeof item.data === 'object' && 'text' in item.data && typeof item.data.text === 'string') {
      for (const line of item.data.text.split('\n').map((line) => line.trim()).filter((line) => line.length >= 4)) {
        bodies.add(line);
        bodies.add(JSON.stringify(line).slice(1, -1));
      }
    }
    for (const child of Object.values(item)) collect(child);
  };
  collect(value);
  collect(evidence);
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && 'kind' in item && typeof item.kind === 'string' && 'data' in item) {
      return withoutSourceSnippetText(item);
    }
    if (typeof item === 'string') {
      let text = item;
      for (const body of bodies) text = text.split(body).join('[source omitted]');
      return text;
    }
    return item;
  }));
}

export function fixedEvidenceClient(benchmarkCase: BenchmarkCase, responses: RuntimeEvidenceResponse[]): RuntimeEvidenceClient {
  return {
    async request(input) {
      const { toRuntimeSafeEvidence } = await agentModule('incident-context');
      const results: RuntimeEvidenceResponse['results'] = input.requests.map((request) => {
        const item = benchmarkCase.supplementalEvidence?.find((item) => item.kind === request.type);
        if (!item) return { requestId: request.requestId, type: request.type, status: 'unavailable', error: 'No recorded supplemental evidence for this capability.' };
        return {
          requestId: request.requestId, type: request.type, status: 'collected', evidenceId: item.id,
          evidence: toRuntimeSafeEvidence(item, 20),
        };
      });
      const parsed = validateRuntimeEvidenceResponse({ schemaVersion: 1, runtimeRequestId: input.runtimeRequestId, results });
      if (!parsed.success) throw new Error(parsed.message);
      responses.push(parsed.value);
      return parsed.value;
    },
  };
}

export async function renderMessage(benchmarkCase: BenchmarkCase, report: RuntimeInvestigationReportInput, evidence: BenchmarkEvidence[]): Promise<{ content: string; bytes: number; fetchCalls: number }> {
  const incident = benchmarkCase.rawIncident;
  if (!incident) throw new Error('raw incident required');
  const { createWeComNotifier } = await agentModule('notifier');
  const { buildNotificationPayload, incidentFactsFromRow } = await agentModule('notification');
  let content = '';
  let fetchCalls = 0;
  const notifier = createWeComNotifier({
    webhookUrl: 'https://capture.invalid/no-network', detailsBaseUrl: 'http://127.0.0.1:8080', timeoutMs: 1000, maxResponseBytes: 128,
    fetch: async (_url: unknown, init?: RequestInit) => {
      fetchCalls++;
      if (typeof init?.body !== 'string') throw new Error('expected string notification body');
      const body: unknown = JSON.parse(init.body);
      if (!body || typeof body !== 'object' || !('markdown' in body)
        || !body.markdown || typeof body.markdown !== 'object' || !('content' in body.markdown)
        || typeof body.markdown.content !== 'string') throw new Error('invalid rendered message');
      content = body.markdown.content;
      return new Response(JSON.stringify({ errcode: 0 }));
    },
  });
  await notifier.send(buildNotificationPayload({
    notificationId: `capture-${benchmarkCase.id}`, type: 'INVESTIGATION_COMPLETED',
    incident: incidentFactsFromRow(incident), evidenceIds: evidence.map((item) => item.id),
    analysis: { ...report, investigationSessionId: 'captured-session', reasoningResultId: 'captured-report' },
  }));
  if (fetchCalls !== 1 || !content) throw new Error('notification was not captured exactly once');
  return { content, bytes: Buffer.byteLength(content), fetchCalls };
}
