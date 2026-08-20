import { execSync } from 'node:child_process';
import type { OpsEvent } from '@pi-ops/protocol';
import type { NodeAgentConfig } from '../config.js';
import type { EventSender } from '../events/sender.js';
import { createHysteresisState } from './hysteresis.js';

export interface DiskDetector {
  start(): void;
  stop(): void;
}

export function createDiskDetector(
  config: NodeAgentConfig,
  sender: EventSender,
): DiskDetector {
  const hysteresis = createHysteresisState(config.diskPressureDuration);

  let timer: ReturnType<typeof setInterval> | null = null;

  function poll(): void {
    let usage: number;
    let totalKb = 0;
    let usedKb = 0;
    let availableKb = 0;

    try {
      const output = execSync(`df -k "${config.diskPressurePath}"`, {
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const lines = output.trim().split('\n');
      const fields = lines[1]?.split(/\s+/) ?? [];
      totalKb = parseInt(fields[1] ?? '0', 10);
      usedKb = parseInt(fields[2] ?? '0', 10);
      availableKb = parseInt(fields[3] ?? '0', 10);
      usage = totalKb > 0 ? usedKb / totalKb : 0;
    } catch {
      // df failed — skip this poll
      return;
    }

    const isAboveThreshold = usage >= config.diskPressureThreshold;
    const transition = hysteresis.sample(isAboveThreshold);

    if (transition === 'pressure') {
      const event: OpsEvent = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        source: 'host',
        nodeId: config.nodeId,
        service: config.nodeId,
        type: 'host.disk_pressure',
        severity: 'warning',
        message: `Disk usage ${(usage * 100).toFixed(1)}% exceeds threshold ${(config.diskPressureThreshold * 100).toFixed(0)}% on ${config.diskPressurePath}`,
        attributes: {
          path: config.diskPressurePath,
          usagePercent: Math.round(usage * 10000) / 100,
          threshold: config.diskPressureThreshold,
          totalKb,
          usedKb,
          availableKb,
          consecutiveSamples: config.diskPressureDuration,
        },
      };
      sender.enqueue(event);
      console.log(`[node-agent] disk pressure detected on ${config.diskPressurePath}: ${(usage * 100).toFixed(1)}%`);
    } else if (transition === 'recovery') {
      const event: OpsEvent = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        source: 'host',
        nodeId: config.nodeId,
        service: config.nodeId,
        type: 'host.disk_recovered',
        severity: 'info',
        message: `Disk usage recovered to ${(usage * 100).toFixed(1)}% on ${config.diskPressurePath}`,
        attributes: {
          path: config.diskPressurePath,
          usagePercent: Math.round(usage * 10000) / 100,
          threshold: config.diskPressureThreshold,
          totalKb,
          usedKb,
          availableKb,
        },
      };
      sender.enqueue(event);
      console.log(`[node-agent] disk pressure recovered on ${config.diskPressurePath}: ${(usage * 100).toFixed(1)}%`);
    }
  }

  return {
    start(): void {
      console.log(`[node-agent] disk detector started (path=${config.diskPressurePath}, threshold ${config.diskPressureThreshold * 100}%, duration ${config.diskPressureDuration})`);
      timer = setInterval(poll, config.detectorPollIntervalMs);
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      console.log('[node-agent] disk detector stopped');
    },
  };
}