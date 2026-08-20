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
  time: z.string().datetime({ offset: true }).or(z.string().min(1)),
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

export interface Evidence {
  id: string;
  incidentId: string;
  nodeId: string;
  source: string;
  kind: string;
  collectedAt: string;
  data: unknown;
}

export const evidenceSchema = z.object({
  id: z.string().min(1),
  incidentId: z.string().min(1),
  nodeId: z.string().min(1),
  source: z.string().min(1),
  kind: z.string().min(1),
  collectedAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
  data: z.unknown(),
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