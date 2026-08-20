import type { OpsEvent } from '@pi-ops/protocol';
import type { NodeAgentConfig } from '../config.js';

// ── Docker event types ───────────────────────────────────────────────────────

export interface DockerEvent {
  Type: string;
  Action: string;
  Actor: {
    ID: string;
    Attributes: Record<string, string>;
  };
  time: number;
  timeNano: number;
}

/** Significant Docker event categories we care about. */
const HIGH_VALUE_ACTIONS = new Set([
  'die',
  'oom',
  'health_status',
]);

/** Container state tracker for detecting restarts after failure. */
interface ContainerState {
  lastAction: string;
  lastEventTime: number;
  name: string;
}

/**
 * Convert a Docker event to an OpsEvent, or null if the event is not
 * significant enough to forward.
 */
export function dockerEventToOpsEvent(
  dockerEvent: DockerEvent,
  config: NodeAgentConfig,
): OpsEvent | null {
  const { Type, Action, Actor, time, timeNano } = dockerEvent;

  // Only container events
  if (Type !== 'container') return null;

  const containerName = Actor.Attributes['name'] ?? Actor.ID.slice(0, 12);
  const image = Actor.Attributes['image'] ?? 'unknown';
  const exitCode = Actor.Attributes['exitCode'];
  const oomKilled = Actor.Attributes['oomKilled'];

  const eventTime = new Date(time * 1000).toISOString();

  let eventType: string;
  let severity: OpsEvent['severity'];
  let message: string;

  switch (Action) {
    case 'die': {
      if (exitCode !== undefined) {
        const code = parseInt(exitCode, 10);
        if (oomKilled === 'true') {
          eventType = 'container.oom';
          severity = 'critical';
          message = `Container ${containerName} OOM killed (exit ${code})`;
        } else if (code !== 0) {
          eventType = 'container.die';
          severity = 'error';
          message = `Container ${containerName} exited with non-zero code ${code}`;
        } else {
          // Normal exit (code 0) — not significant
          return null;
        }
      } else {
        eventType = 'container.die';
        severity = 'error';
        message = `Container ${containerName} died`;
      }
      break;
    }
    case 'oom': {
      eventType = 'container.oom';
      severity = 'critical';
      message = `Container ${containerName} OOM`;
      break;
    }
    case 'health_status': {
      const healthStatus = Actor.Attributes['health_status'] ?? '';
      if (healthStatus === 'unhealthy') {
        eventType = 'health.failure';
        severity = 'error';
        message = `Container ${containerName} health check failed`;
      } else if (healthStatus === 'healthy') {
        eventType = 'health.recovered';
        severity = 'info';
        message = `Container ${containerName} health check recovered`;
      } else {
        return null;
      }
      break;
    }
    default:
      return null;
  }

  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    time: eventTime,
    source: 'docker',
    nodeId: config.nodeId,
    service: containerName,
    type: eventType,
    severity,
    message,
    attributes: {
      containerId: Actor.ID,
      containerName,
      image,
      exitCode: exitCode !== undefined ? parseInt(exitCode, 10) : undefined,
      oomKilled: oomKilled === 'true',
      dockerAction: Action,
    },
  };
}

/**
 * Track recently seen container states to detect restarts after failure.
 */
export function createContainerStateTracker(): {
  track(dockerEvent: DockerEvent): 'restart' | null;
} {
  const states = new Map<string, ContainerState>();

  // Time window for considering a start as a restart after failure (ms)
  const RESTART_WINDOW_MS = 60 * 1000; // 1 minute

  return {
    track(dockerEvent: DockerEvent): 'restart' | null {
      const containerId = dockerEvent.Actor.ID;
      const now = dockerEvent.time * 1000;

      if (dockerEvent.Action === 'die') {
        states.set(containerId, {
          lastAction: 'die',
          lastEventTime: now,
          name: dockerEvent.Actor.Attributes['name'] ?? containerId.slice(0, 12),
        });
        return null;
      }

      if (dockerEvent.Action === 'start') {
        const prev = states.get(containerId);
        if (prev && prev.lastAction === 'die' && (now - prev.lastEventTime) <= RESTART_WINDOW_MS) {
          states.delete(containerId);
          return 'restart';
        }
        // Normal start — track but don't flag as restart
        states.set(containerId, {
          lastAction: 'start',
          lastEventTime: now,
          name: dockerEvent.Actor.Attributes['name'] ?? containerId.slice(0, 12),
        });
      }

      return null;
    },
  };
}