import {
  INVESTIGATION_RUNTIME_SCHEMA_VERSION,
  validateInvestigationSubmitRequest,
  type InvestigationSubmitAck,
} from '@pi-ops/protocol';
import type { InvestigationContext } from './investigation-context.js';
import type { InvestigationSession } from './investigation-session.js';
import type { PiRuntimeClient, PiRuntimeSubmitAck } from './pi-runtime-client.js';
import type { InvestigationPlan } from './reasoning-strategy.js';

export function createHttpPiRuntimeClient(options: {
  baseUrl: string;
  token: string;
  callbackUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): PiRuntimeClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const baseUrl = options.baseUrl.replace(/\/$/, '');

  return {
    async submit(_plan: InvestigationPlan): Promise<PiRuntimeSubmitAck | void> {
      return undefined;
    },
    async poll(_planId: string) {
      return undefined;
    },
    async submitInvestigation(
      session: InvestigationSession,
      context: InvestigationContext,
    ): Promise<PiRuntimeSubmitAck | void> {
      const payload = {
        schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
        runtimeRequestId: session.runtimeRequestId,
        sessionId: session.id,
        incidentId: session.incidentId,
        context,
        callbackUrl: options.callbackUrl,
      };
      const parsed = validateInvestigationSubmitRequest(payload);
      if (!parsed.success) throw new Error(parsed.message);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/v1/investigations`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(parsed.value),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`pi-runtime submit ${response.status}`);
        }
        const ack = await response.json() as InvestigationSubmitAck;
        if (!ack.runtimeTaskId) throw new Error('pi-runtime ack missing runtimeTaskId');
        return { runtimeTaskId: ack.runtimeTaskId };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
