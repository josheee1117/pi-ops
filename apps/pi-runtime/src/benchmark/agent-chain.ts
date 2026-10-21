import { validateRuntimeInvestigationContext, validateRuntimeEvidenceResponse, type RuntimeInvestigationContext, type RuntimeEvidenceResponse, type RuntimeInvestigationReportInput } from '@pi-ops/protocol';
import type { RuntimeEvidenceClient } from '../evidence-client.js';
import type { BenchmarkCase, BenchmarkEvidence } from './fixtures.js';

// Dynamic imports keep the benchmark-only agent dependency outside runtime's production rootDir.
async function agentModule(name: string) {
  return import(new URL(`../../../agent/src/${name}.ts`, import.meta.url).href);
}

export async function projectCase(benchmarkCase: BenchmarkCase): Promise<RuntimeInvestigationContext> {
  if (!benchmarkCase.rawIncident) throw new Error('raw incident required');
  const { buildIncidentContext } = await agentModule('incident-context');
  const projected = buildIncidentContext(benchmarkCase.rawIncident, benchmarkCase.evidence, {
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
    webhookUrl: 'https://capture.invalid/no-network', timeoutMs: 1000, maxResponseBytes: 128,
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
