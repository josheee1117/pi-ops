import {
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';

export interface RuntimeModelRequest {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface RuntimeModelResponse {
  text: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface RuntimeModel {
  readonly provider: string;
  readonly model: string;
  readonly networkCalls: number;
  invoke(request: RuntimeModelRequest): Promise<RuntimeModelResponse>;
}

export interface FakeRuntimeModelOptions {
  delayMs?: number;
  specialistText?: Partial<Record<SpecialistRole, string>>;
  synthesisText?: string;
}

const ROLE_EVIDENCE: Record<SpecialistRole, string[]> = {
  jvm: ['host.memory', 'docker.stats', 'host.load'],
  database: ['docker.stats', 'host.load', 'docker.inspect'],
  container_host: ['docker.inspect', 'docker.stats', 'host.memory', 'host.load', 'docker.logs'],
  application_business: ['http.probe', 'docker.logs', 'docker.inspect', 'host.load'],
};

export function createFakeRuntimeModel(options: FakeRuntimeModelOptions = {}): RuntimeModel & { invocations: number } {
  const model: RuntimeModel & { invocations: number } = {
    provider: 'fake',
    model: 'deterministic',
    networkCalls: 0,
    invocations: 0,
    async invoke(request) {
      model.invocations += 1;
      if (request.signal?.aborted) throw new Error('aborted');
      if (options.delayMs) await delay(options.delayMs, request.signal);
      const role = specialistRoleFrom(request.system);
      if (role) {
        const scripted = options.specialistText?.[role];
        if (scripted !== undefined) {
          return { text: scripted, provider: 'fake', model: 'deterministic', inputTokens: 1, outputTokens: 1 };
        }
        const context = JSON.parse(request.user) as RuntimeInvestigationContext;
        return {
          text: JSON.stringify(deterministicFinding(role, context)),
          provider: 'fake',
          model: 'deterministic',
          inputTokens: 8,
          outputTokens: 24,
        };
      }
      if (request.system.includes('COORDINATOR_SYNTHESIS')) {
        return {
          text: options.synthesisText ?? '{}',
          provider: 'fake',
          model: 'deterministic',
          inputTokens: 8,
          outputTokens: 24,
        };
      }
      throw new Error('unsupported fake model prompt');
    },
  };
  return model;
}

export function deterministicFinding(
  role: SpecialistRole,
  context: RuntimeInvestigationContext,
): SpecialistFinding {
  const supportingEvidenceIds = context.evidence
    .filter((item) => ROLE_EVIDENCE[role].includes(item.kind))
    .map((item) => item.id);
  const kinds = new Set(context.evidence.map((item) => item.kind));
  return {
    role,
    hypotheses: [hypothesisFor(role, context.incident.type)],
    supportingEvidenceIds,
    contradictingEvidenceIds: [],
    missingEvidence: missingFor(role, kinds),
    confidence: supportingEvidenceIds.length > 0 ? 0.72 : 0.4,
    summary: `${role} reviewed current Evidence only. Historical knowledge is advisory.`,
    status: 'completed',
  };
}

export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(raw) as unknown;
}

function hypothesisFor(role: SpecialistRole, type: string): string {
  if (role === 'database') return 'SQL or database contention on the current incident';
  if (role === 'jvm') return 'JVM resource pressure on the current incident';
  if (role === 'container_host') {
    if (type.startsWith('container.')) return 'container or host resource limit on the current incident';
    return 'host/container signals for the current incident';
  }
  return `application-level ${type} on the current incident`;
}

function missingFor(role: SpecialistRole, kinds: Set<string>): SpecialistFinding['missingEvidence'] {
  if (role === 'database' && !kinds.has('docker.stats')) return ['docker.stats'];
  if (role === 'jvm' && !kinds.has('host.memory')) return ['host.memory'];
  if (role === 'container_host' && !kinds.has('docker.inspect')) return ['docker.inspect'];
  if (!(RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes('docker.inspect')) return [];
  return [];
}

function specialistRoleFrom(system: string): SpecialistRole | undefined {
  const match = /SPECIALIST_ROLE=([a-z_]+)/.exec(system);
  const role = match?.[1];
  if (role === 'jvm' || role === 'database' || role === 'container_host' || role === 'application_business') {
    return role;
  }
  return undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
