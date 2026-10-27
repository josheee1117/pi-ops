export function createPollingWorker(options: {
  name: string;
  intervalMs: number;
  reset(): number;
  drain(): Promise<void>;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<void> | undefined;
  let wakeQueued = false;

  async function runOnce(): Promise<void> {
    if (activeRun) return activeRun;
    activeRun = options.drain().finally(() => {
      activeRun = undefined;
    });
    return activeRun;
  }

  function wake(): void {
    if (wakeQueued) return;
    wakeQueued = true;
    queueMicrotask(() => {
      wakeQueued = false;
      void runOnce().catch((err) => {
        console.error(`[agent] ${options.name} worker error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  return {
    start(): void {
      const reset = options.reset();
      if (reset > 0) console.log(`[agent] reset ${reset} interrupted ${options.name} job(s)`);
      wake();
      timer = setInterval(wake, options.intervalMs);
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (activeRun) await activeRun;
    },
    wake,
    runOnce,
  };
}
