import { z } from 'zod';

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
  collectedAt: z.string().datetime({ offset: true }),
  data: z.unknown(),
}).superRefine((value, ctx) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'data')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['data'],
      message: 'Required',
    });
  }
});
