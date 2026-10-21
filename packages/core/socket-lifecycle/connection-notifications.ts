type ConnectionListener = () => void | Promise<void>;

/** Socket notifications cannot interrupt transport setup or another consumer. */
export class RelayConnectionNotifications {
  private readonly listeners = new Set<ConnectionListener>();

  subscribe(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  connected(): void {
    for (const listener of this.listeners) {
      try { void Promise.resolve(listener()).catch(() => {}); }
      catch { /* A consumer failure does not close a healthy socket. */ }
    }
  }
}
