type SourceObservation<T> = { fingerprint: string; reusable?: (value: T) => boolean };
/** Serializes expensive repository analysis without blocking Mesh snapshots. */
export class RepositoryGraphJobs<T> {
  private readonly entries = new Map<string, {
    value?: T;
    retryAt: number;
    pending: boolean;
    listeners: Array<(value: T | undefined) => void>;
    sourceFingerprint?: string;
  }>();
  private readonly queue: Array<{
    key: string; run: () => Promise<T | undefined>; priority: number;
  }> = [];
  private running = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly successMs = 120_000,
    private readonly failureMs = 300_000,
    private readonly capacity = 32,
    private readonly storage?: {read(key:string):{value:T;savedAt:number;sourceFingerprint?:string}|undefined;
      write(key:string,value:T,sourceFingerprint?:string):void},
  ) {}

  read(key: string, run: () => Promise<T | undefined>, priority = 0, force = false,
    source?: SourceObservation<T>): T | undefined {
    if (!this.entries.has(key)) {
      const saved = this.storage?.read(key);
      if (saved) this.entries.set(key, {value:saved.value,retryAt:saved.savedAt+this.successMs,
        pending:false,listeners:[],sourceFingerprint:saved.sourceFingerprint});
    }
    const previous = this.entries.get(key);
    if (previous?.pending) return previous.value;
    if (previous && !force && this.now() < previous.retryAt) return previous.value;
    if (!force && source && previous?.value !== undefined
      && previous.sourceFingerprint === source.fingerprint && source.reusable?.(previous.value) !== false) {
      return previous.value;
    }
    if (!this.admit(priority)) return undefined;
    if (!previous && this.entries.size >= this.capacity * 2) {
      const oldest = [...this.entries].find(([, entry]) => !entry.pending)?.[0];
      if (!oldest) return undefined;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value: previous?.value, retryAt: 0, pending: true, listeners: [],
      sourceFingerprint: source?.fingerprint });
    const admitted = this.entries.get(key);
    const before = this.queue.findIndex((job) => job.priority < priority);
    const observedRun = async () => {
      const value = await run();
      if (value !== undefined && source?.reusable?.(value) === false && this.entries.get(key) === admitted) {
        admitted!.sourceFingerprint = undefined;
      }
      return value;
    };
    this.queue.splice(before < 0 ? this.queue.length : before, 0, { key, run: observedRun, priority });
    void this.drain();
    return previous?.value;
  }

  /** A requested build joins the same revision's automatic job and raises its queue priority. */
  refresh(key: string, run: () => Promise<T | undefined>, priority = Number.MAX_SAFE_INTEGER,
    source?: SourceObservation<T>): Promise<T | undefined> {
    if (!this.entries.get(key)?.pending) this.read(key, run, priority, true, source);
    const entry = this.entries.get(key);
    if (!entry?.pending) return Promise.resolve(undefined);
    const index = this.queue.findIndex(job => job.key === key);
    if (index >= 0) {
      const job = this.queue.splice(index, 1)[0]!;
      job.priority = Math.max(priority, job.priority);
      const before = this.queue.findIndex(other => other.priority < job.priority);
      this.queue.splice(before < 0 ? this.queue.length : before, 0, job);
    }
    return new Promise(resolve => entry.listeners.push(resolve));
  }

  /** Read a fresh in-memory result without starting or queueing an analysis. */
  cached(key: string): T | undefined {
    const entry = this.entries.get(key);
    return entry && this.now() < entry.retryAt ? entry.value : undefined;
  }

  private admit(priority: number): boolean {
    if (this.queue.length < this.capacity) return true;
    const last = this.queue[this.queue.length - 1];
    if (!last || last.priority >= priority) return false;
    this.queue.pop();
    const entry = this.entries.get(last.key);
    if (entry) {
      entry.pending = false;
      entry.retryAt = this.now() + this.failureMs;
      for (const listener of entry.listeners) listener(undefined);
      entry.listeners = [];
    }
    return true;
  }

  /** An explicit refresh supersedes an older queued or running observation. */
  remember(key: string, value: T | undefined): void {
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.queue[index]!.key === key) this.queue.splice(index, 1);
    }
    if (!this.entries.has(key) && this.entries.size >= this.capacity * 2) {
      const oldest = [...this.entries].find(([, entry]) => !entry.pending)?.[0];
      if (!oldest) return;
      this.entries.delete(oldest);
    }
    for (const listener of this.entries.get(key)?.listeners ?? []) listener(value);
    if (value !== undefined) this.storage?.write(key, value);
    this.entries.set(key, { value, pending: false, listeners: [],
      retryAt: this.now() + (value === undefined ? this.failureMs : this.successMs) });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        const entry = this.entries.get(job.key);
        let value: T | undefined;
        try { value = await job.run(); } catch { /* Retry after backoff. */ }
        if (this.entries.get(job.key) !== entry) continue;
        if (value !== undefined) this.storage?.write(job.key, value, entry?.sourceFingerprint);
        this.entries.set(job.key, {
          value,
          retryAt: this.now() + (value === undefined ? this.failureMs : this.successMs),
          pending: false,
          listeners: [],
          sourceFingerprint: entry?.sourceFingerprint,
        });
        for (const listener of entry?.listeners ?? []) listener(value);
      }
    } finally {
      this.running = false;
    }
  }
}
