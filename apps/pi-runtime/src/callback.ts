import type { InvestigationRuntimeResult } from '@pi-ops/protocol';

export async function postRuntimeResult(
  callbackUrl: string,
  token: string,
  result: InvestigationRuntimeResult,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(callbackUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(result),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`callback ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
