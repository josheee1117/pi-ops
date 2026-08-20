import type { NodeAgentConfig } from '../config.js';

/** Shared test defaults so config growth does not break every suite. */
export function makeNodeAgentConfig(overrides: Partial<NodeAgentConfig> = {}): NodeAgentConfig {
  return {
    port: 0,
    nodeToken: 'test-token',
    nodeId: 'test-node',
    allowedContainers: new Set(['dataease']),
    dockerSocketPath: '/var/run/docker.sock',
    allowedDiskPaths: new Set(['/', '/var']),
    logsMaxLines: 200,
    logsMaxBytes: 1024 * 1024,
    dockerQueryTimeoutMs: 5000,
    probeMaxTimeoutMs: 30000,
    maxResponseBytes: 1024 * 1024,
    maxRequestBytes: 64 * 1024,
    agentUrl: 'http://localhost:8080',
    ingestToken: 'test-token',
    eventQueueSize: 1000,
    eventSendTimeoutMs: 5000,
    eventMaxRetries: 3,
    eventFlushIntervalMs: 1000,
    detectorPollIntervalMs: 10_000,
    memoryPressureThreshold: 0.9,
    memoryPressureDuration: 3,
    diskPressureThreshold: 0.9,
    diskPressurePath: '/',
    diskPressureDuration: 3,
    healthTargets: [{ name: 'test-health', url: 'http://localhost:8080/health' }],
    healthFailureDuration: 2,
    ...overrides,
  };
}
