import os from 'node:os';
import type { OpsEvent } from '@pi-ops/protocol';
import type { NodeAgentConfig } from '../config.js';
import type { EventSender } from '../events/sender.js';
import { createHysteresisState } from './hysteresis.js';

export interface MemoryDetector {
  start(): void;
  stop(): void;
}

export function createMemoryDetector(
  config: NodeAgentConfig,
  sender: EventSender,
): MemoryDetector {
  const hysteresis = createHysteresisState(config.memoryPressureDuration);

  let timer: ReturnType<typeof setInterval> | null = null;

  function poll(): void {
    const total = os.totalmem();
    const free = os.freemem();
    const usage = (total - free) / total;
    const isAboveThreshold = usage >= config.memoryPressureThreshold;

    const transition = hysteresis.sample(isAboveThreshold);

    if (transition === 'pressure') {
      const event: OpsEvent = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        source: 'host',
        nodeId: config.nodeId,
        service: config.nodeId,
        type: 'host.memory_pressure',
        severity: 'warning',
        message: `Memory usage ${(usage * 100).toFixed(1)}% exceeds threshold ${(config.memoryPressureThreshold * 100).toFixed(0)}%`,
        attributes: {
          usagePercent: Math.round(usage * 10000) / 100,
          threshold: config.memoryPressureThreshold,
          totalBytes: total,
          freeBytes: free,
          usedBytes: total - free,
          consecutiveSamples: config.memoryPressureDuration,
        },
      };
      sender.enqueue(event);
      console.log(`[node-agent] memory pressure detected: ${(usage * 100).toFixed(1)}%`);
    } else if (transition === 'recovery') {
      const event: OpsEvent = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        source: 'host',
        nodeId: config.nodeId,
        service: config.nodeId,
        type: 'host.memory_recovered',
        severity: 'info',
        message: `Memory usage recovered to ${(usage * 100).toFixed(1)}%`,
        attributes: {
          usagePercent: Math.round(usage * 10000) / 100,
          threshold: config.memoryPressureThreshold,
          totalBytes: total,
          freeBytes: free,
          usedBytes: total - free,
        },
      };
      sender.enqueue(event);
      console.log(`[node-agent] memory pressure recovered: ${(usage * 100).toFixed(1)}%`);
    }
  }

  return {
    start(): void {
      console.log(`[node-agent] memory detector started (threshold ${config.memoryPressureThreshold * 100}%, duration ${config.memoryPressureDuration})`);
      timer = setInterval(poll, config.detectorPollIntervalMs);
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      console.log('[node-agent] memory detector stopped');
    },
  };
}