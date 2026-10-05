export class ExecutionQueue {
  private readonly threadTails = new Map<string, Promise<void>>();
  private readonly userPending = new Map<string, number>();
  private activeGlobal = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly globalLimit = 2) {}

  async run<T>(userId: string, threadId: string, task: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
    this.userPending.set(userId, (this.userPending.get(userId) ?? 0) + 1);
    const key = `${userId}:${threadId}`;
    const previous = this.threadTails.get(key) ?? Promise.resolve();
    let releaseThread!: () => void;
    const current = new Promise<void>(resolve => {
      releaseThread = resolve;
    });
    const tail = previous.then(() => current);
    this.threadTails.set(key, tail);
    let acquired = false;
    try {
      await previous;
      await this.acquireGlobal(abortSignal);
      acquired = true;
      if (abortSignal?.aborted) throw new Error('Execution was cancelled');
      return await task();
    } finally {
      if (acquired) this.releaseGlobal();
      releaseThread();
      if (this.threadTails.get(key) === tail) this.threadTails.delete(key);
      const remaining = (this.userPending.get(userId) ?? 1) - 1;
      if (remaining) this.userPending.set(userId, remaining);
      else this.userPending.delete(userId);
    }
  }

  isUserBusy(userId: string): boolean {
    return (this.userPending.get(userId) ?? 0) > 0;
  }

  private acquireGlobal(abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) return Promise.reject(new Error('Execution was cancelled'));
    if (this.activeGlobal < this.globalLimit) {
      this.activeGlobal += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        abortSignal?.removeEventListener('abort', onAbort);
        this.activeGlobal += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Execution was cancelled'));
      };
      this.waiters.push(waiter);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (abortSignal?.aborted) onAbort();
    });
  }

  private releaseGlobal(): void {
    this.activeGlobal -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export const commandQueue = new ExecutionQueue(2);
