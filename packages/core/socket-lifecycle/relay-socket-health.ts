import WebSocket from "ws";

/** Detect half-open network sockets independently of managed authorization. */
export class RelaySocketHealth {
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private release?: () => void;
  private awaitingPong = false;

  start(socket: WebSocket, interval: number, timeout = interval): void {
    this.stop();
    this.socket = socket;
    const alive = () => {
      if (this.socket !== socket) return;
      this.awaitingPong = false;
      clearTimeout(this.deadline);
      this.deadline = undefined;
    };
    socket.on("pong", alive);
    socket.on("ping", alive);
    socket.on("message", alive);
    const closed = () => this.stop(socket);
    socket.once("close", closed);
    this.release = () => {
      socket.off("pong", alive);
      socket.off("ping", alive);
      socket.off("message", alive);
      socket.off("close", closed);
    };
    this.timer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) { this.stop(socket); return; }
      if (this.awaitingPong) return;
      this.awaitingPong = true;
      const deadline = setTimeout(() => {
        // Process buffered network evidence after a busy event loop before declaring the link dead.
        setImmediate(() => {
          if (this.socket !== socket || this.deadline !== deadline || !this.awaitingPong) return;
          this.stop(socket);
          socket.terminate();
        });
      }, timeout);
      this.deadline = deadline;
      this.deadline.unref();
      try { socket.ping(); }
      catch { this.stop(socket); socket.terminate(); }
    }, interval);
    this.timer.unref();
  }

  stop(socket?: WebSocket): void {
    if (socket && this.socket !== socket) return;
    if (this.timer) clearInterval(this.timer);
    clearTimeout(this.deadline);
    this.release?.();
    this.release = undefined;
    this.deadline = undefined;
    this.timer = undefined;
    this.socket = undefined;
    this.awaitingPong = false;
  }
}
