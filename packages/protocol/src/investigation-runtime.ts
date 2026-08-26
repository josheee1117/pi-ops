import { z, ZodError } from 'zod';

export const INVESTIGATION_RUNTIME_SCHEMA_VERSION = 1 as const;

export const SPECIALIST_ROLES = [
  'jvm',
  'database',
  'container_host',
  'application_business',
] as const;

export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

export const MAX_SPECIALISTS_PER_INVESTIGATION = 3;

export const RUNTIME_ALLOWED_EVIDENCE_TYPES = [
  'docker.inspect',
  'docker.logs',
  'docker.stats',
  'host.memory',
  'host.load',
  'host.disk',
  'http.probe',
] as const;

export const RUNTIME_FORBIDDEN_CAPABILITIES = [
  'bash',
  'shell',
  'restart',
  'redeploy',
  'write',
  'edit',
] as const;

export type HistoricalKnowledgeStatus = 'available' | 'unavailable';

export const specialistFindingSchema = z.object({
  role: z.enum(SPECIALIST_ROLES),
  hypotheses: z.array(z.string().min(1)).max(5),
  supportingEvidenceIds: z.array(z.string().min(1)).max(20),
  contradictingEvidenceIds: z.array(z.string().min(1)).max(20),
  missingEvidence: z.array(z.enum(RUNTIME_ALLOWED_EVIDENCE_TYPES)).max(8),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(2000),
  status: z.enum(['completed', 'failed']),
});

export type SpecialistFinding = z.infer<typeof specialistFindingSchema>;

export const investigationReportInputSchema = z.object({
  schemaVersion: z.literal(INVESTIGATION_RUNTIME_SCHEMA_VERSION).optional(),
  hypothesis: z.string().min(1).max(2000),
  supportingEvidenceIds: z.array(z.string().min(1)).max(50),
  contradictingEvidenceIds: z.array(z.string().min(1)).max(50),
  confidence: z.number().min(0).max(1),
  recommendation: z.string().min(1).max(2000),
});

export type InvestigationReportInput = z.infer<typeof investigationReportInputSchema>;

export const investigationRuntimeMetadataSchema = z.object({
  runtimeRequestId: z.string().min(1),
  runtimeTaskId: z.string().min(1),
  selectedSpecialists: z.array(z.enum(SPECIALIST_ROLES)).max(MAX_SPECIALISTS_PER_INVESTIGATION),
  specialistStatus: z.record(z.enum(['completed', 'failed', 'skipped'])),
  latencyMs: z.number().int().nonnegative(),
  provider: z.string().optional(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reportStatus: z.enum(['completed', 'failed']),
  historicalKnowledgeStatus: z.enum(['available', 'unavailable']).optional(),
});

export type InvestigationRuntimeMetadata = z.infer<typeof investigationRuntimeMetadataSchema>;

export const investigationSubmitRequestSchema = z.object({
  schemaVersion: z.literal(INVESTIGATION_RUNTIME_SCHEMA_VERSION),
  runtimeRequestId: z.string().min(1),
  sessionId: z.string().min(1),
  incidentId: z.string().min(1),
  context: z.unknown(),
  callbackUrl: z.string().url(),
});

export type InvestigationSubmitRequest = z.infer<typeof investigationSubmitRequestSchema>;

export const investigationSubmitAckSchema = z.object({
  schemaVersion: z.literal(INVESTIGATION_RUNTIME_SCHEMA_VERSION),
  runtimeRequestId: z.string().min(1),
  runtimeTaskId: z.string().min(1),
  duplicate: z.boolean(),
});

export type InvestigationSubmitAck = z.infer<typeof investigationSubmitAckSchema>;

export const investigationRuntimeResultSchema = z.object({
  schemaVersion: z.literal(INVESTIGATION_RUNTIME_SCHEMA_VERSION),
  runtimeRequestId: z.string().min(1),
  runtimeTaskId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  report: investigationReportInputSchema.optional(),
  error: z.string().max(2000).optional(),
  metadata: investigationRuntimeMetadataSchema.optional(),
});

export type InvestigationRuntimeResult = z.infer<typeof investigationRuntimeResultSchema>;

export const runtimeEvidenceRequestSchema = z.object({
  type: z.enum(RUNTIME_ALLOWED_EVIDENCE_TYPES),
  incidentId: z.string().min(1),
}).passthrough();

const runtimeContextSchema = z.object({
  schemaVersion: z.literal(INVESTIGATION_RUNTIME_SCHEMA_VERSION),
  incident: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    service: z.string().min(1),
  }).passthrough(),
  evidence: z.array(z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
  }).passthrough()),
  historicalKnowledgeStatus: z.enum(['available', 'unavailable']).optional(),
  historicalKnowledge: z.unknown().optional(),
  conflictingMemories: z.array(z.unknown()).optional(),
}).passthrough();

export type RuntimeInvestigationContext = z.infer<typeof runtimeContextSchema>;

export interface ValidationResult<T> {
  success: true;
  value: T;
}

export interface ValidationError {
  success: false;
  errors: z.ZodIssue[];
  message: string;
}

export type ValidationOutcome<T> = ValidationResult<T> | ValidationError;

export function validateInvestigationSubmitRequest(
  data: unknown,
): ValidationOutcome<InvestigationSubmitRequest> {
  return validate(investigationSubmitRequestSchema, data);
}

export function validateInvestigationRuntimeResult(
  data: unknown,
): ValidationOutcome<InvestigationRuntimeResult> {
  return validate(investigationRuntimeResultSchema, data);
}

export function validateRuntimeInvestigationContext(
  data: unknown,
): ValidationOutcome<RuntimeInvestigationContext> {
  return validate(runtimeContextSchema, data);
}

export function validateSpecialistFinding(data: unknown): ValidationOutcome<SpecialistFinding> {
  return validate(specialistFindingSchema, data);
}

function validate<T>(schema: z.ZodSchema<T>, data: unknown): ValidationOutcome<T> {
  const result = schema.safeParse(data);
  if (result.success) return { success: true, value: result.data };
  return {
    success: false,
    errors: result.error.issues,
    message: formatZodError(result.error),
  };
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}
