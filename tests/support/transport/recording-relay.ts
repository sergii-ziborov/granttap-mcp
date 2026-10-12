import assert from "node:assert/strict";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { WebSocketServer } from "ws";
import type { RelayClient } from "../../../packages/core/relay-client";

/** Real TCP writes exercise the transport queue without altering RelayClient internals. */
export async function recordingRelay(context: TestContext) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const frames: string[] = [];
  server.on("connection", socket => socket.on("message", data => frames.push(data.toString())));
  context.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function until(predicate: (frames: string[]) => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate(frames) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(frames), "Expected relay frame was not received");
  }
  return { url: `ws://127.0.0.1:${address.port}`, frames, until,
    async connect(client: RelayClient, helloCopies = 1) {
      context.after(() => client.close());
      await client.connect();
      await until(items => items.length >= helloCopies);
      frames.splice(0);
    } };
}
