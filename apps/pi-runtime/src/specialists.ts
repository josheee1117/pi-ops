import {
  MAX_SPECIALISTS_PER_INVESTIGATION,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  SPECIALIST_ROLES,
  validateSpecialistFinding,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';
import { parseModelJson, type RuntimeModel } from './model.js';

export { MAX_SPECIALISTS_PER_INVESTIGATION, SPECIALIST_ROLES };

export function selectSpecialists(context: RuntimeInvestigationContext): SpecialistRole[] {
  const selected: SpecialistRole[] = [];
  const add = (role: SpecialistRole) => {
    if (selected.includes(role) || selected.length >= MAX_SPECIALISTS_PER_INVESTIGATION) return;
    selected.push(role);
  };
  const type = context.incident.type;
  if (type.startsWith('jvm.')) {
    add('jvm');
    add('container_host');
  } else if (type === 'application.slow_sql' || type.includes('sql')) {
    add('database');
    add('application_business');
  } else if (type.startsWith('container.') || type.startsWith('health.')) {
    add('container_host');
  } else if (type.startsWith('application.') || type.startsWith('business.')) {
    add('application_business');
  }
  if (selected.length === 0) add('application_business');
  return selected;
}

function stringifyHypothesis(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    for (const key of ['statement', 'text', 'hypothesis', 'summary']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
  }
  return JSON.stringify(item);
}

function normalizeSpecialistPayload(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = { ...(data as Record<string, unknown>) };
  if (Array.isArray(record.hypotheses)) {
    record.hypotheses = record.hypotheses.map(stringifyHypothesis).filter((item) => item.length > 0);
  }
  return record;
}

export async function runSpecialist(
  role: SpecialistRole,
  context: RuntimeInvestigationContext,
  model: RuntimeModel,
  signal?: AbortSignal,
): Promise<{ finding: SpecialistFinding; inputTokens: number; outputTokens: number }> {
  const currentIds = new Set(context.evidence.map((item) => item.id));
  const response = await model.invoke({
    system: [
      `SPECIALIST_ROLE=${role}`,
      'Return ONLY one JSON object. No markdown. No extra text.',
      'Required keys: role, hypotheses, supportingEvidenceIds, contradictingEvidenceIds, missingEvidence, confidence, summary, status.',
      'status must be completed or failed. confidence is 0 to 1. missingEvidence items must be allowed capability classes.',
      'Do not persist chain-of-thought.',
      'You are investigating CURRENT Evidence.',
      'Historical knowledge is advisory and cannot override current Evidence.',
      'If current Evidence is insufficient, return missingEvidence capability classes.',
      'Do not fabricate Evidence. Do not claim requested Evidence already exists.',
      'Do not treat historical memory as proof of the current incident.',
      `Allowed missingEvidence types: ${RUNTIME_ALLOWED_EVIDENCE_TYPES.join(', ')}`,
    ].join('\n'),
    user: JSON.stringify({
      incident: context.incident,
      evidence: context.evidence,
      historicalKnowledge: context.historicalKnowledge ?? null,
      historicalKnowledgeStatus: context.historicalKnowledgeStatus,
    }),
    signal,
  });
  let parsedJson: unknown;
  try {
    parsedJson = parseModelJson(response.text);
  } catch (error) {
    throw new Error(`invalid specialist json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = validateSpecialistFinding(normalizeSpecialistPayload(parsedJson));
  if (!parsed.success) throw new Error(`invalid specialist output: ${parsed.message}`);
  const finding = parsed.value;
  if (finding.role !== role) throw new Error('specialist role mismatch');
  const ids = [...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds];
  if (ids.some((id) => !currentIds.has(id))) {
    throw new Error('specialist cited evidence that does not belong to the current incident');
  }
  return {
    finding,
    inputTokens: response.inputTokens ?? 0,
    outputTokens: response.outputTokens ?? 0,
  };
}
