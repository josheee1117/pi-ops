import type { OpsEvent } from '@pi-ops/protocol';
import type { NodeAgentConfig, HealthTarget } from '../config.js';
import type { EventSender } from '../events/sender.js';
import { createHysteresisState, type HysteresisState } from './hysteresis.js';

export interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export type ProbeFn = (
  url: string,
  method: string,
  timeoutMs: number,
) => Promise<ProbeResult>;

export interface HealthDetector {
  start(): void;
  stop(): void;
  /** Run one probe cycle for all targets. Exposed for tests. */
  pollOnce(): Promise<void>;
}

export async function defaultProbe(
  url: string,
  method: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    await res.body?.cancel().catch(() => {});
    return { ok: res.status >= 200 && res.status < 400, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function healthTargetKey(target: HealthTarget): string {
  return JSON.stringify([target.name, target.url, target.method ?? 'GET', target.container]);
}

export function createHealthDetector(
  config: NodeAgentConfig,
  sender: EventSender,
  probe: ProbeFn = defaultProbe,
): HealthDetector {
  const states = new Map<string, HysteresisState>();
  const timers: ReturnType<typeof setInterval>[] = [];

  for (const target of config.healthTargets) {
    states.set(healthTargetKey(target), createHysteresisState(config.healthFailureDuration));
  }

  async function probeTarget(target: HealthTarget): Promise<void> {
    const method = target.method ?? 'GET';
    const timeout = config.probeMaxTimeoutMs;
    const result = await probe(target.url, method, timeout);
    const hysteresis = states.get(healthTargetKey(target));
    if (!hysteresis) return;

    // isAboveThreshold = unhealthy (failed probe)
    const transition = hysteresis.sample(!result.ok);
    if (!transition) return;

    const transitionTime = new Date().toISOString();
    const attributes = {
      detector: 'http.health',
      target: target.name,
      url: target.url,
      method,
      containerName: target.container,
      status: result.status,
      ...(target.ruleId !== undefined ? { ruleId: target.ruleId } : {}),
      ...(target.ruleVersion !== undefined ? { ruleVersion: target.ruleVersion } : {}),
      failureSamples: config.healthFailureDuration,
      intervalMs: target.intervalMs ?? config.detectorPollIntervalMs,
      transitionTime,
    };

    if (transition === 'pressure') {
      const event: OpsEvent = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        time: transitionTime,
        source: 'health',
        nodeId: config.nodeId,
        service: target.name,
        type: 'health.failure',
        severity: 'error',
        message: `Health check failed for ${target.name}` +
          (result.status !== undefined ? ` (HTTP ${result.status})` : result.error ? ` (${result.error})` : ''),
        attributes: { ...attributes, error: result.error },
      };
      sender.enqueue(event);
      console.log(`[node-agent] health failure: ${target.name}`);
    } else if (transition === 'recovery') {
      const event: OpsEvent = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        time: transitionTime,
        source: 'health',
        nodeId: config.nodeId,
        service: target.name,
        type: 'health.recovered',
        severity: 'info',
        message: `Health check recovered for ${target.name}` +
          (result.status !== undefined ? ` (HTTP ${result.status})` : ''),
        attributes,
      };
      sender.enqueue(event);
      console.log(`[node-agent] health recovered: ${target.name}`);
    }
  }

  async function pollOnce(): Promise<void> {
    await Promise.all(config.healthTargets.map((t) => probeTarget(t)));
  }

  return {
    start(): void {
      if (config.healthTargets.length === 0) {
        console.log('[node-agent] health detector idle (no PI_OPS_HEALTH_TARGETS)');
        return;
      }
      console.log(
        `[node-agent] health detector started (${config.healthTargets.length} target(s), duration ${config.healthFailureDuration})`,
      );
      for (const target of config.healthTargets) {
        const interval = target.intervalMs ?? config.detectorPollIntervalMs;
        timers.push(setInterval(() => {
          probeTarget(target).catch((err) => {
            console.error(`[node-agent] health probe error (${target.name}): ${err instanceof Error ? err.message : String(err)}`);
          });
        }, interval));
      }
    },
    stop(): void {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      console.log('[node-agent] health detector stopped');
    },
    pollOnce,
  };
}
