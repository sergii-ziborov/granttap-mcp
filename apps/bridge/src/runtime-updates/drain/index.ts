/** How long new phone messages may wait for the running work to end before the update gives way. */
export const HOLD_LIMIT_MS = 10 * 60_000;
/** After a hold gave up, the messages it kept waiting get this long to start before another hold. */
export const HOLD_PAUSE_MS = 5 * 60_000;
/** When no provider run was to blame for a hold giving up, the next one follows after this. */
export const HOLD_RETRY_MS = 30 * 60_000;
/** The launcher replaces a monitor within seconds of being told; past this the monitor works on. */
export const HANDOFF_LIMIT_MS = 2 * 60_000;
/** How often a holding monitor asks whether its running work has ended. */
export const HOLD_POLL_MS = 5_000;
/** A staged release that failed its start check is not started again sooner than this. */
export const VERIFY_RETRY_MS = 30 * 60_000;

type Options = {
  now?: () => number;
  log?: (line: string) => void;
  /** When the longest-running provider run of this monitor began; undefined when none is running. */
  oldestRun?: () => number | undefined;
};

/**
 * Lets a newer runtime take over a monitor that is never idle. Messages keep arriving, so waiting for
 * an idle moment can take hours; instead the monitor stops starting queued work, lets what is running
 * end, and hands over. The hold is bounded, so a run that lasts hours delays other chats once, by
 * `HOLD_LIMIT_MS`, and the next hold waits until that run has ended.
 */
export class UpdateDrain {
  private since?: number;
  private handoffAt?: number;
  private version?: string;
  private notBefore = 0;
  /** Runs still going when the last hold gave up; a new hold cannot succeed before they end. */
  private outlastedAt?: number;
  private passed?: string;
  /** The release whose start check last failed, and when. */
  private broken?: { version: string; at: number };

  constructor(private readonly options: Options = {}) {}

  /** New queued work waits while this is true. It stays staged on this computer and on the relay. */
  holding(): boolean {
    this.expire();
    return this.since !== undefined;
  }

  /** A verified newer runtime waits for a busy monitor. Returns whether new work is now held for it. */
  request(version?: string): boolean {
    this.expire();
    if (this.since !== undefined) return true;
    const now = this.now();
    if (now < this.notBefore || this.outlasting()) return false;
    this.since = now;
    this.version = version;
    this.outlastedAt = undefined;
    this.log(`${this.label()} is ready. New phone messages wait for the running work to end, `
      + `${minutes(HOLD_LIMIT_MS)} min at most.`);
    return true;
  }

  /** The update is selected and the launcher is told. Nothing new starts in a monitor about to be replaced. */
  handoff(version?: string): void {
    this.expire();
    if (this.handoffAt !== undefined) return;
    const now = this.now(), waited = this.since === undefined ? 0 : now - this.since;
    this.handoffAt = now;
    this.since ??= now;
    this.version = version ?? this.version;
    this.log(`${this.label()} is selected and the monitor restarts with it`
      + (waited > 0 ? `; new phone messages waited ${Math.round(waited / 1000)} s.` : '.'));
  }

  /** Automatic updates were turned off: nothing is waiting any more. */
  cancel(): void {
    if (this.since === undefined || this.handoffAt !== undefined) return;
    this.log(`${this.label()} no longer waits: automatic updates are off. Phone messages run again.`);
    this.since = undefined;
  }

  /** Selecting the update failed, as on a full disk. The hold ends now instead of at its limit. */
  failed(): void {
    if (this.since === undefined || this.handoffAt !== undefined) return;
    this.log(`${this.label()} could not be selected. Phone messages run again; the update is tried again in `
      + `${minutes(HOLD_RETRY_MS)} min.`);
    this.notBefore = this.now() + HOLD_RETRY_MS;
    this.since = undefined;
  }

  /** Starts a staged release once per version, so a hold is taken only for one that works. */
  async verified(version: string, verify: () => Promise<void>): Promise<boolean> {
    if (this.passed === version) return true;
    if (this.broken?.version === version && this.now() - this.broken.at < VERIFY_RETRY_MS) return false;
    try { await verify(); }
    catch (error) { this.broken = { version, at: this.now() }; throw error; }
    this.passed = version;
    this.broken = undefined;
    return true;
  }

  private expire(): void {
    if (this.since === undefined) return;
    const now = this.now();
    if (this.handoffAt !== undefined) {
      if (now - this.handoffAt < HANDOFF_LIMIT_MS) return;
      this.log(`${this.label()} is selected, but the monitor was not restarted in `
        + `${minutes(HANDOFF_LIMIT_MS)} min. Phone messages run again.`);
      this.notBefore = now + HOLD_RETRY_MS;
    } else {
      if (now - this.since < HOLD_LIMIT_MS) return;
      const running = this.options.oldestRun?.() !== undefined;
      this.outlastedAt = running ? now : undefined;
      this.notBefore = now + (running ? HOLD_PAUSE_MS : HOLD_RETRY_MS);
      this.log(`${this.label()} still waits: the running work did not end in ${minutes(HOLD_LIMIT_MS)} min. `
        + `Phone messages run again; the update is tried again `
        + (running ? 'when the runs still going have ended.' : `in ${minutes(HOLD_RETRY_MS)} min.`));
    }
    this.since = undefined;
    this.handoffAt = undefined;
  }

  private outlasting(): boolean {
    if (this.outlastedAt === undefined) return false;
    const oldest = this.options.oldestRun?.();
    return oldest !== undefined && oldest <= this.outlastedAt;
  }

  private label(): string { return this.version ? `Update ${this.version}` : 'The selected update'; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private log(line: string): void { this.options.log?.(line); }
}

function minutes(ms: number): number { return Math.round(ms / 60_000); }
