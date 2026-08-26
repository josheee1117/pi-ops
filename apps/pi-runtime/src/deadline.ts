export class ExecutionTimeoutError extends Error {
  constructor() {
    super('execution timeout');
    this.name = 'ExecutionTimeoutError';
  }
}

export async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const workPromise = work(controller.signal);
  const settled = workPromise.then(
    (value) => ({ kind: 'ok' as const, value }),
    (error: unknown) => ({ kind: 'err' as const, error }),
  );
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    const finish = () => resolve({ kind: 'timeout' });
    if (controller.signal.aborted) {
      finish();
      return;
    }
    controller.signal.addEventListener('abort', finish, { once: true });
  });
  try {
    const winner = await Promise.race([settled, timeout]);
    if (winner.kind === 'timeout') {
      void settled;
      throw new ExecutionTimeoutError();
    }
    if (winner.kind === 'err') throw winner.error;
    if (controller.signal.aborted) throw new ExecutionTimeoutError();
    return winner.value;
  } finally {
    clearTimeout(timer);
  }
}
