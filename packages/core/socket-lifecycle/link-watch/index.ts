export type LinkStuckReport = { failures: number; reason: string };

/**
 * Notices a computer that cannot stay on the relay. Each refused upgrade, and each socket that
 * closes before it held for a minute, is a failure; six inside five minutes with no link that held
 * is reported once per ten minutes with the relay's last reason. On 2026-11-05 the monitor was
 * refused for hours while the phone showed the computer online, and nothing said why.
 */
export class RelayLinkWatch {
  private failures: number[] = [];
  private openedAt?: number;
  private reportedAt = -Infinity;

  constructor(private readonly options: {
    onStuck: (report: LinkStuckReport) => void;
    now?: () => number;
    windowMs?: number;
    holdMs?: number;
    threshold?: number;
    quietMs?: number;
  }) {}

  private get now(): number { return (this.options.now ?? Date.now)(); }

  opened(): void { this.openedAt = this.now; }

  closed(code: number, reason: string): void {
    const opened = this.openedAt;
    this.openedAt = undefined;
    if (opened === undefined) return;
    if (this.now - opened >= (this.options.holdMs ?? 60_000)) { this.failures = []; return; }
    this.failed(`${code} ${reason}`.trim());
  }

  failed(reason: string): void {
    const now = this.now;
    const window = this.options.windowMs ?? 5 * 60_000;
    this.failures = [...this.failures.filter(at => now - at < window), now];
    if (this.failures.length < (this.options.threshold ?? 6)) return;
    if (now - this.reportedAt < (this.options.quietMs ?? 10 * 60_000)) return;
    this.reportedAt = now;
    this.options.onStuck({ failures: this.failures.length, reason });
  }
}
