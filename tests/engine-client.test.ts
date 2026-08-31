import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EngineClient } from "../apps/bridge/src/engine/engine-client";
import {
  EngineFrameDecoder,
  EngineProtocolError,
  EngineRemoteError,
  MAX_ENGINE_FRAME_BYTES,
  encodeEngineFrame,
  type EngineRequest,
} from "../apps/bridge/src/engine/engine-protocol";

const socketPath = (name: string) => join(
  "/tmp",
  `granttap-engine-client-${process.pid}-${name}.sock`,
);

async function listen(server: Server, path: string): Promise<void> {
  await rm(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

async function close(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(path, { force: true });
}

test("engine framing is bounded and survives partial input", () => {
  const frame = encodeEngineFrame({ protocol_version: 1, request_id: "r", operation: "engine.ping" });
  const decoder = new EngineFrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  assert.equal(decoder.push(frame.subarray(3))[0]?.request_id, "r");

  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_ENGINE_FRAME_BYTES + 1);
  assert.throws(() => new EngineFrameDecoder().push(oversized), EngineProtocolError);
});

test("client multiplexes requests over one versioned Unix socket", async () => {
  const path = socketPath("multiplex");
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    const decoder = new EngineFrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk) as EngineRequest[]) {
        const result = request.operation === "engine.ping"
          ? { operation: "engine.pong", engine_version: "0.1.0" }
          : { operation: "engine.version", engine_version: "0.1.0", protocol_version: 1 };
        socket.write(encodeEngineFrame({
          protocol_version: 1,
          request_id: request.request_id,
          status: "ok",
          result,
        }));
      }
    });
  });
  await listen(server, path);
  const client = new EngineClient({ socketPath: path, connectTimeoutMs: 100 });
  const [pong, version] = await Promise.all([
    client.request({ operation: "engine.ping" }, { timeoutMs: 100 }),
    client.request({ operation: "engine.version" }, { timeoutMs: 100 }),
  ]);
  assert.equal(pong.operation, "engine.pong");
  assert.equal(version.operation, "engine.version");
  assert.equal(connections, 1);
  client.close();
  await close(server, path);
});

test("request timeout does not retry a critical-path action", async () => {
  const path = socketPath("timeout");
  let requests = 0;
  const server = createServer((socket) => {
    const decoder = new EngineFrameDecoder();
    socket.on("data", (chunk) => { requests += decoder.push(chunk).length; });
  });
  await listen(server, path);
  const client = new EngineClient({ socketPath: path, connectTimeoutMs: 100 });
  await assert.rejects(
    client.request({ operation: "engine.ping" }, { timeoutMs: 20 }),
    /deadline/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests, 1);
  client.close();
  await close(server, path);
});

test("protocol mismatch invalidates the connection", async () => {
  const path = socketPath("version");
  const server = createServer((socket) => {
    const decoder = new EngineFrameDecoder();
    socket.on("data", (chunk) => {
      const request = decoder.push(chunk)[0] as EngineRequest | undefined;
      if (!request) return;
      socket.write(encodeEngineFrame({
        protocol_version: 2,
        request_id: request.request_id,
        status: "ok",
        result: { operation: "engine.pong", engine_version: "future" },
      }));
    });
  });
  await listen(server, path);
  const client = new EngineClient({ socketPath: path, connectTimeoutMs: 100 });
  await assert.rejects(
    client.request({ operation: "engine.ping" }, { timeoutMs: 100 }),
    EngineProtocolError,
  );
  client.close();
  await close(server, path);
});

test("remote action error rejects only its request and preserves the socket", async () => {
  const path = socketPath("remote-error");
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    const decoder = new EngineFrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk) as EngineRequest[]) {
        const response = request.operation === "engine.ping"
          ? { status: "error", error: { code: "PING_REJECTED", message: "no ping" } }
          : {
            status: "ok",
            result: { operation: "engine.version", engine_version: "0.1.0", protocol_version: 1 },
          };
        socket.write(encodeEngineFrame({
          protocol_version: 1,
          request_id: request.request_id,
          ...response,
        }));
      }
    });
  });
  await listen(server, path);
  const client = new EngineClient({ socketPath: path, connectTimeoutMs: 100 });
  await assert.rejects(
    client.request({ operation: "engine.ping" }, { timeoutMs: 100 }),
    (error) => error instanceof EngineRemoteError && error.code === "PING_REJECTED",
  );
  const version = await client.request({ operation: "engine.version" }, { timeoutMs: 100 });
  assert.equal(version.operation, "engine.version");
  assert.equal(connections, 1);
  client.close();
  await close(server, path);
});

test("client bounds pending work, rejects close, and cannot be reused", async () => {
  const path = socketPath("capacity");
  let markReceived: () => void = () => undefined;
  const received = new Promise<void>((resolve) => { markReceived = resolve; });
  const server = createServer((socket) => {
    socket.on("data", () => markReceived());
  });
  await listen(server, path);
  const client = new EngineClient({
    socketPath: path,
    connectTimeoutMs: 100,
    maxPendingRequests: 1,
  });
  const first = client.request({ operation: "engine.ping" }, { timeoutMs: 1_000 });
  void first.catch(() => undefined);
  await received;
  await assert.rejects(
    client.request({ operation: "engine.version" }, { timeoutMs: 100 }),
    /capacity/i,
  );
  client.close();
  await assert.rejects(first, /closed/i);
  await assert.rejects(client.request({ operation: "engine.ping" }), /closed/i);
  await close(server, path);
});

test("unexpected result operation closes a compromised connection", async () => {
  const path = socketPath("operation");
  const server = createServer((socket) => {
    const decoder = new EngineFrameDecoder();
    socket.on("data", (chunk) => {
      const request = decoder.push(chunk)[0] as EngineRequest | undefined;
      if (!request) return;
      socket.write(encodeEngineFrame({
        protocol_version: 1,
        request_id: request.request_id,
        status: "ok",
        result: { operation: "engine.pong", engine_version: "wrong operation" },
      }));
    });
  });
  await listen(server, path);
  const client = new EngineClient({ socketPath: path, connectTimeoutMs: 100 });
  await assert.rejects(
    client.request({ operation: "engine.version" }, { timeoutMs: 100 }),
    /operation mismatch/i,
  );
  client.close();
  await close(server, path);
});

test("connection failure is explicit and never creates a retry loop", async () => {
  const path = socketPath("missing");
  await rm(path, { force: true });
  const client = new EngineClient({ socketPath: path, connectTimeoutMs: 20 });
  await assert.rejects(client.request({ operation: "engine.ping" }, { timeoutMs: 50 }));
  client.close();
});
