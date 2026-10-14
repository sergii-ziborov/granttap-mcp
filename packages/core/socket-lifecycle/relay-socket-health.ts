import WebSocket from "ws";

/** Detect half-open network sockets independently of managed authorization. */
export class RelaySocketHealth {
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private awaitingPong = false;

  start(socket: WebSocket, interval: number): void {
    this.stop();
    this.socket = socket;
    socket.on("pong", () => { if (this.socket === socket) this.awaitingPong = false; });
    this.timer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) { this.stop(socket); return; }
      if (this.awaitingPong) { this.stop(socket); socket.terminate(); return; }
      this.awaitingPong = true;
      try { socket.ping(); }
      catch { this.stop(socket); socket.terminate(); }
    }, interval);
    this.timer.unref();
    socket.once("close", () => this.stop(socket));
  }

  stop(socket?: WebSocket): void {
    if (socket && this.socket !== socket) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.socket = undefined;
    this.awaitingPong = false;
  }
}
