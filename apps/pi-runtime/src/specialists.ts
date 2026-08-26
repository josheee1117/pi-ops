import {
  MAX_SPECIALISTS_PER_INVESTIGATION,
  SPECIALIST_ROLES,
  type RuntimeInvestigationContext,
  type SpecialistFinding,
  type SpecialistRole,
} from '@pi-ops/protocol';

export { MAX_SPECIALISTS_PER_INVESTIGATION, SPECIALIST_ROLES };

export function selectSpecialists(context: RuntimeInvestigationContext): SpecialistRole[] {
  const selected: SpecialistRole[] = [];
  const add = (role: SpecialistRole) => {
    if (selected.includes(role) || selected.length >= MAX_SPECIALISTS_PER_INVESTIGATION) return;
    selected.push(role);
  };
  const type = context.incident.type;
  if (type.startsWith('jvm.')) add('jvm');
  if (type.includes('sql') || type.includes('gc')) add('database');
  if (
    type.startsWith('container.')
    || type.startsWith('health.')
    || type.startsWith('jvm.')
    || context.evidence.some((item) => item.kind.startsWith('docker.') || item.kind.startsWith('host.'))
  ) {
    add('container_host');
  }
  if (type.startsWith('application.') || type.startsWith('business.')) add('application_business');
  if (selected.length === 0) add('application_business');
  return selected;
}

export function runSpecialist(
  role: SpecialistRole,
  context: RuntimeInvestigationContext,
): SpecialistFinding {
  const currentIds = context.evidence.map((item) => item.id);
  const primary = currentIds[0] ? [currentIds[0]] : [];
  const hypothesis = hypothesisFor(role, context);
  return {
    role,
    hypotheses: [hypothesis],
    supportingEvidenceIds: primary,
    contradictingEvidenceIds: [],
    missingEvidence: missingFor(role, context),
    confidence: primary.length > 0 ? 0.72 : 0.4,
    summary: `${role} reviewed current Evidence only. Historical knowledge is advisory.`,
    status: 'completed',
  };
}

function hypothesisFor(role: SpecialistRole, context: RuntimeInvestigationContext): string {
  const type = context.incident.type;
  if (role === 'database') return 'SQL or database contention on the current incident';
  if (role === 'jvm') return 'JVM resource pressure on the current incident';
  if (role === 'container_host') {
    if (type.startsWith('container.')) return 'container or host resource limit on the current incident';
    return 'host/container signals for the current incident';
  }
  return `application-level ${type} on the current incident`;
}

function missingFor(
  role: SpecialistRole,
  context: RuntimeInvestigationContext,
): SpecialistFinding['missingEvidence'] {
  const kinds = new Set(context.evidence.map((item) => item.kind));
  if (role === 'database' && !kinds.has('docker.stats')) return ['docker.stats'];
  if (role === 'jvm' && !kinds.has('host.memory')) return ['host.memory'];
  if (role === 'container_host' && !kinds.has('docker.inspect')) return ['docker.inspect'];
  return [];
}
