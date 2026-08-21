import { MAX_BATCH_SIZE, type OpsEvent, type EventBatch } from '@pi-ops/protocol';
import type { NodeAgentConfig } from '../config.js';

export interface EventSender {
  /** Enqueue an event for delivery. Non-blocking. Returns false if dropped. */
  enqueue(event: OpsEvent): boolean;
  /** Number of events dropped due to queue overflow or send failures. */
  droppedCount(): number;
  /** Start the background flush loop. */
  start(): void;
  /** Stop the background flush loop and flush remaining events. */
  stop(): Promise<void>;
  /** Queue depth for monitoring. */
  queueDepth(): number;
}

export function createEventSender(config: NodeAgentConfig): EventSender {
  const queue: OpsEvent[] = [];
  let dropped = 0;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeRun: Promise<void> | undefined;
  let drainRequested = false;

  const producerId = config.nodeId;
  const producerVersion = '0.1.0';

  function enqueue(event: OpsEvent): boolean {
    if (queue.length >= config.eventQueueSize) {
      dropped++;
      console.warn(`[node-agent] event queue full (${config.eventQueueSize}), dropping event ${event.id}`);
      return false;
    }
    queue.push(event);
    return true;
  }

  function droppedCount(): number {
    return dropped;
  }

  function queueDepth(): number {
    return queue.length;
  }

  async function sendBatch(batch: OpsEvent[]): Promise<boolean> {
    const eventBatch: EventBatch = {
      producer: {
        id: producerId,
        type: 'node-agent',
        version: producerVersion,
      },
      events: batch,
    };
    const body = JSON.stringify(eventBatch);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= config.eventMaxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.eventSendTimeoutMs);

        const res = await fetch(`${config.agentUrl}/v1/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.ingestToken}`,
          },
          body,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          if (attempt > 0) {
            console.log(`[node-agent] event push succeeded on attempt ${attempt + 1}`);
          }
          return true;
        }

        const resText = await res.text().catch(() => '');
        lastError = new Error(`HTTP ${res.status}: ${resText.slice(0, 200)}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt < config.eventMaxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(`[node-agent] event push attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    dropped += batch.length;
    console.error(`[node-agent] event push failed after ${config.eventMaxRetries + 1} attempts, dropping ${batch.length} events: ${lastError?.message}`);
    return false;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.splice(0, Math.min(MAX_BATCH_SIZE, queue.length));
      const ok = await sendBatch(batch);
      if (!ok) return;
    }
  }

  function requestDrain(): void {
    drainRequested = true;
    if (activeRun) return;
    activeRun = (async () => {
      try {
        while (drainRequested) {
          drainRequested = false;
          await drain();
        }
      } catch (err) {
        console.error(`[node-agent] event flush error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        activeRun = undefined;
        if (drainRequested) requestDrain();
      }
    })();
  }

  function start(): void {
    running = true;
    timer = setInterval(() => {
      if (!running) return;
      requestDrain();
    }, config.eventFlushIntervalMs);
    console.log(`[node-agent] event sender started (flush every ${config.eventFlushIntervalMs}ms, queue max ${config.eventQueueSize})`);
  }

  async function stop(): Promise<void> {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    requestDrain();
    if (activeRun) await activeRun;
    console.log(`[node-agent] event sender stopped (total dropped: ${dropped})`);
  }

  return { enqueue, droppedCount, start, stop, queueDepth };
}
