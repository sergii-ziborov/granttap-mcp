/** Activity routes replaceable traffic; authorization remains a separate check. */
export class ActiveControllerRecipients {
  private readonly seen = new Map<string, number>();

  observe(peer: string, now = Date.now()): void {
    this.seen.set(peer, now);
  }

  allows(peer: string, replaceable: boolean, now = Date.now()): boolean {
    if (!replaceable) return true;
    const active = [...this.seen].filter(([, at]) => now >= at && now - at <= 90_000);
    // A newly connected transport has not heard its controllers yet.
    return active.length === 0 || active.some(([key]) => key === peer);
  }
}
