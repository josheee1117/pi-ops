import type { AgentConfig } from '../config.js';

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
    operatorToken: 'operator-token',
    investigationRetryMaxAttempts: 3,
    investigationRetryBackoffMs: 0,
    investigationStaleTimeoutMs: 60_000,
    externalRuntimeEnabled: false,
    sqlitePath: ':memory:',
    nodeId: 'central',
    maxBodySize: 1024 * 1024,
    aggregationWindowMs: 5 * 60 * 1000,
    nodeAgents: new Map(),
    evidenceTimeoutMs: 1000,
    evidenceMaxResponseBytes: 1024 * 1024,
    evidenceLogsMaxLines: 200,
    evidenceJobPollIntervalMs: 1000,
    evidenceJobMaxAttempts: 3,
    evidenceJobBatchSize: 10,
    eventReplayBatchSize: 100,
    reasoningJobPollIntervalMs: 1000,
    reasoningTimeoutMs: 5000,
    reasoningJobBatchSize: 10,
    reasonerType: 'fake',
    reasoningMaxContextBytes: 32_768,
    reasoningMaxEvidenceItems: 12,
    reasoningMaxLogLines: 50,
    ...overrides,
  };
}
