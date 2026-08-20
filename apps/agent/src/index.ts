// Central pi-ops-agent entrypoint.
// Milestone 1: verify protocol import works.
import { CURRENT_SCHEMA_VERSION, MAX_BATCH_SIZE } from '@pi-ops/protocol';

export function getProtocolVersion(): number {
  return CURRENT_SCHEMA_VERSION;
}

export function getBatchSizeLimit(): number {
  return MAX_BATCH_SIZE;
}

console.log(`[pi-ops-agent] protocol v${CURRENT_SCHEMA_VERSION}, max batch ${MAX_BATCH_SIZE}`);