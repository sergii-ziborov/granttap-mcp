/** Serializes expensive repository analysis without blocking Mesh snapshots. */
export class RepositoryGraphJobs<T> {
  private readonly entries = new Map<string, {
    value?: T;
    retryAt: number;
    pending: boolean;
  }>();
  private readonly queue: Array<{ key: string; run: () => Promise<T | undefined> }> = [];
  private running = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly successMs = 120_000,
    private readonly failureMs = 300_000,
    private readonly capacity = 32,
  ) {}

  read(key: string, run: () => Promise<T | undefined>): T | undefined {
    const previous = this.entries.get(key);
    if (previous?.pending) return undefined;
    if (previous && this.now() < previous.retryAt) return previous.value;
    if (this.queue.length >= this.capacity) return undefined;
    if (!previous && this.entries.size >= this.capacity * 2) {
      const oldest = [...this.entries].find(([, entry]) => !entry.pending)?.[0];
      if (!oldest) return undefined;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { retryAt: 0, pending: true });
    this.queue.push({ key, run });
    void this.drain();
    return undefined;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        let value: T | undefined;
        try { value = await job.run(); } catch { /* Retry after backoff. */ }
        this.entries.set(job.key, {
          value,
          retryAt: this.now() + (value === undefined ? this.failureMs : this.successMs),
          pending: false,
        });
      }
    } finally {
      this.running = false;
    }
  }
}
