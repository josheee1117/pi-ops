import { z, ZodError } from 'zod';

// ── Constants ────────────────────────────────────────────────────────────────

export const CURRENT_SCHEMA_VERSION = 1 as const;

/** Maximum events per batch. Reject the entire batch if exceeded. */
export const MAX_BATCH_SIZE = 1000;

// ── OpsEvent ─────────────────────────────────────────────────────────────────

export type OpsEventSource =
  | 'jfr'
  | 'application'
  | 'docker'
  | 'host'
  | 'health'
  | 'middleware'
  | 'deployment';

export type OpsEventSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface OpsEvent {
  schemaVersion: 1;
  id: string;
  time: string;
  source: OpsEventSource;
  nodeId: string;
  service: string;
  type: string;
  severity: OpsEventSeverity;
  fingerprint?: string;
  traceId?: string;
  message: string;
  attributes: Record<string, unknown>;
}

const opsEventSourceSchema = z.enum([
  'jfr',
  'application',
  'docker',
  'host',
  'health',
  'middleware',
  'deployment',
]);

const opsEventSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);

export const opsEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  time: z.string().datetime({ offset: true }),
  source: opsEventSourceSchema,
  nodeId: z.string().min(1),
  service: z.string().min(1),
  type: z.string().min(1),
  severity: opsEventSeveritySchema,
  fingerprint: z.string().optional(),
  traceId: z.string().optional(),
  message: z.string().min(1),
  attributes: z.record(z.unknown()),
});

// ── EventBatch ───────────────────────────────────────────────────────────────

export interface EventBatch {
  producer: {
    id: string;
    type: 'application' | 'node-agent';
    version: string;
  };
  events: OpsEvent[];
}

export const eventBatchSchema = z.object({
  producer: z.object({
    id: z.string().min(1),
    type: z.enum(['application', 'node-agent']),
    version: z.string().min(1),
  }),
  events: z.array(opsEventSchema).min(1).max(MAX_BATCH_SIZE),
});

// ── Evidence ─────────────────────────────────────────────────────────────────

import { evidenceSchema, type Evidence } from './evidence-schema.js';
export { evidenceSchema } from './evidence-schema.js';
export type { Evidence } from './evidence-schema.js';

// ── Evidence query ───────────────────────────────────────────────────────────

export const EVIDENCE_QUERY_TYPES = [
  'docker.inspect',
  'docker.logs',
  'docker.stats',
  'host.memory',
  'host.load',
  'host.disk',
  'http.probe',
] as const;

export type EvidenceQueryType = (typeof EVIDENCE_QUERY_TYPES)[number];

export interface EvidenceQueryRequest {
  type: EvidenceQueryType;
  incidentId: string;
  container?: string;
  maxLines?: number;
  /** Absolute ISO datetime or a bounded duration such as `2m`. */
  since?: string;
  /** Absolute ISO datetime upper bound for docker.logs. */
  until?: string;
  path?: string;
  url?: string;
  method?: string;
  timeout?: number;
}

export const evidenceQueryRequestSchema = z.object({
  type: z.enum(EVIDENCE_QUERY_TYPES),
  incidentId: z.string().min(1),
  container: z.string().min(1).optional(),
  maxLines: z.number().int().positive().optional(),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  url: z.string().url().optional(),
  method: z.string().min(1).optional(),
  timeout: z.number().int().positive().optional(),
});

// ── Validation helpers ───────────────────────────────────────────────────────

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

export function validateOpsEvent(data: unknown): ValidationOutcome<OpsEvent> {
  return validate(opsEventSchema, data) as ValidationOutcome<OpsEvent>;
}

export function validateEventBatch(data: unknown): ValidationOutcome<EventBatch> {
  return validate(eventBatchSchema, data) as ValidationOutcome<EventBatch>;
}

export function validateEvidence(data: unknown): ValidationOutcome<Evidence> {
  return validate(evidenceSchema, data) as ValidationOutcome<Evidence>;
}

export function validateEvidenceQueryRequest(
  data: unknown,
): ValidationOutcome<EvidenceQueryRequest> {
  return validate(evidenceQueryRequestSchema, data) as ValidationOutcome<EvidenceQueryRequest>;
}

function validate<T>(schema: z.ZodSchema<T>, data: unknown): ValidationOutcome<T> {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, value: result.data };
  }
  return {
    success: false,
    errors: result.error.issues,
    message: formatZodError(result.error),
  };
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export { z, ZodError };

export {
  INVESTIGATION_RUNTIME_SCHEMA_VERSION,
  SPECIALIST_ROLES,
  MAX_SPECIALISTS_PER_INVESTIGATION,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  RUNTIME_FORBIDDEN_CAPABILITIES,
  type RuntimeEvidenceType,
  MAX_EVIDENCE_ENRICHMENT_ROUNDS,
  MAX_EVIDENCE_TYPES_PER_SPECIALIST,
  MAX_EVIDENCE_REQUESTS_PER_INVESTIGATION,
  specialistFindingSchema,
  investigationReportInputSchema,
  investigationRuntimeMetadataSchema,
  investigationSubmitRequestSchema,
  investigationSubmitAckSchema,
  investigationRuntimeResultSchema,
  runtimeEvidenceRequestSchema,
  runtimeEvidenceRequestBatchSchema,
  runtimeEvidenceResponseSchema,
  validateInvestigationSubmitRequest,
  validateInvestigationRuntimeResult,
  validateRuntimeInvestigationContext,
  validateSpecialistFinding,
  validateRuntimeEvidenceRequestBatch,
  validateRuntimeEvidenceResponse,
} from './investigation-runtime.js';
export type {
  SpecialistRole,
  HistoricalKnowledgeStatus,
  SpecialistFinding,
  InvestigationReportInput as RuntimeInvestigationReportInput,
  InvestigationRuntimeMetadata,
  InvestigationSubmitRequest,
  InvestigationSubmitAck,
  InvestigationRuntimeResult,
  RuntimeInvestigationContext,
  RuntimeEvidenceRequestBatch,
  RuntimeEvidenceResult,
  RuntimeEvidenceResponse,
} from './investigation-runtime.js';