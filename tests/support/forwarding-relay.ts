import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export type ForwardingRelay = {
  url: string;
  connections: () => number;
  close: () => Promise<void>;
};

export async function forwardingRelay(): Promise<ForwardingRelay> {
  const http = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      for (const peer of sockets) {
        if (peer !== socket && peer.readyState === peer.OPEN) peer.send(data);
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address === "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    connections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
