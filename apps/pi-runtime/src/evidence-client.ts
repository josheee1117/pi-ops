import {
  INVESTIGATION_RUNTIME_SCHEMA_VERSION,
  MAX_EVIDENCE_REQUESTS_PER_INVESTIGATION,
  validateRuntimeEvidenceRequestBatch,
  validateRuntimeEvidenceResponse,
  type RuntimeEvidenceResponse,
  type SpecialistRole,
} from '@pi-ops/protocol';

export interface RuntimeEvidenceClient {
  request(input: {
    runtimeRequestId: string;
    runtimeTaskId: string;
    sessionId: string;
    requests: Array<{
      requestId: string;
      type: RuntimeEvidenceResponse['results'][number]['type'];
      requestingRoles?: SpecialistRole[];
    }>;
  }): Promise<RuntimeEvidenceResponse>;
}

export function createHttpRuntimeEvidenceClient(options: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): RuntimeEvidenceClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  return {
    async request(input) {
      const payload = {
        schemaVersion: INVESTIGATION_RUNTIME_SCHEMA_VERSION,
        runtimeRequestId: input.runtimeRequestId,
        runtimeTaskId: input.runtimeTaskId,
        sessionId: input.sessionId,
        requests: input.requests.slice(0, MAX_EVIDENCE_REQUESTS_PER_INVESTIGATION),
      };
      const parsed = validateRuntimeEvidenceRequestBatch(payload);
      if (!parsed.success) throw new Error(parsed.message);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/v1/investigation-evidence`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(parsed.value),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`evidence request ${response.status}`);
        const body: unknown = await response.json();
        const validated = validateRuntimeEvidenceResponse(body);
        if (!validated.success) throw new Error(validated.message);
        return validated.value;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
