/** Retry pacing survives refused handshakes and short-lived WebSockets. */
export class RelayReconnectBackoff {
  private next: number;
  private notBefore = 0;

  constructor(private readonly minimum = 1_000, private readonly maximum = 15_000,
    private readonly now = Date.now, private readonly random = Math.random) {
    this.next = minimum;
  }

  closed(openedAt: number | undefined, code: number, reason: string): void {
    const policy = code === 1008 || code === 1009 || (code >= 4400 && code <= 4499);
    if (!policy && openedAt !== undefined && this.now() - openedAt >= 30_000) this.next = this.minimum;
    this.defer(/(?:^|;\s*)retry-after=(\d{1,5})(?:;|$)/.exec(reason)?.[1]);
    if (policy) this.notBefore = Math.max(this.notBefore, this.now() + Math.min(60_000, this.maximum));
  }

  /** Server Retry-After is a floor, independent of the ordinary reconnect cap. */
  defer(value: string | string[] | undefined): void {
    if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return;
    this.notBefore = Math.max(this.notBefore, this.now() + Number(value) * 1_000);
  }

  delay(): number {
    const jittered = Math.round(Math.max(this.minimum, Math.min(this.maximum, this.next * (0.8 + this.random() * 0.4))));
    this.next = Math.min(this.maximum, this.next * 2);
    return Math.max(jittered, this.notBefore - this.now());
  }
}
