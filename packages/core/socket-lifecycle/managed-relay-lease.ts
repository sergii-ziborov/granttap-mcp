import WebSocket from "ws";
import type { RelayClientOptions } from "../relay-client-types";

/** Renew a computer's signed admission on its existing socket; no chat keys change. */
export class ManagedRelayLease {
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;

  start(socket: WebSocket, options: RelayClientOptions): void {
    this.stop();
    this.socket = socket;
    socket.once("close", () => this.stop(socket));
    this.schedule(socket, options);
  }

  stop(socket?: WebSocket): void {
    if (socket && this.socket !== socket) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.socket = undefined;
  }

  private schedule(socket: WebSocket, options: RelayClientOptions, retry = false): void {
    const expiry = options.connectionLeaseExpiresAt?.();
    if (!expiry || !Number.isFinite(expiry) || !options.upgradeHeaders) return;
    const remaining = expiry - Date.now();
    const margin = Math.min(30_000, Math.max(10, remaining * 0.15));
    const delay = retry ? 10_000 : Math.max(10, remaining - margin);
    this.timer = setTimeout(() => void this.renew(socket, options), delay);
    this.timer.unref();
  }

  private async renew(socket: WebSocket, options: RelayClientOptions): Promise<void> {
    this.timer = undefined;
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      const headers = await options.upgradeHeaders!();
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      const ticket = headers["X-GrantTap-Admission"];
      if (!ticket) throw new Error("No refreshed relay admission");
      await new Promise<void>((resolve, reject) => socket.send(
        JSON.stringify({ type: "relay.admission", ticket }), error => error ? reject(error) : resolve()));
      this.schedule(socket, options);
    } catch {
      // The relay's signed expiry remains authoritative; a failed lookup cannot extend it.
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) this.schedule(socket, options, true);
    }
  }
}
