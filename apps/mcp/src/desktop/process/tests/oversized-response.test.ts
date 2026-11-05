import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineFrameDecoder, encodeEngineFrame } from "../../../../../bridge/src/engine/protocol/engine-protocol";
import { startDesktopEngineBridge } from "../../engine-bridge";

test("an oversized desktop result leaves the bridge available for the next request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-desktop-frame-"));
  const before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = directory;
  const bridge = await startDesktopEngineBridge({
    storePath: join(directory, "project-mesh.json"),
    client: { request: async () => ({ filler: "x".repeat(600_000) } as never), close() {} },
  });
  t.after(async () => {
    await bridge.close();
    if (before === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = before;
    await rm(directory, { recursive: true, force: true });
  });

  const oversized = await request(bridge.socketPath, "engine.version");
  assert.equal(oversized.status, "error");
  assert.equal((oversized.error as { code: string }).code, "ENGINE_RESPONSE_UNAVAILABLE");
  const next = await request(bridge.socketPath, "desktop.workspace");
  assert.equal(next.status, "ok");
  assert.equal((next.result as { project_count: number }).project_count, 0);
});

function request(socketPath: string, operation: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const decoder = new EngineFrameDecoder();
    let result: Record<string, unknown> | undefined;
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error("desktop request timed out")); });
    socket.on("connect", () => socket.write(encodeEngineFrame({
      protocol_version: 1, request_id: operation, operation,
    })));
    socket.on("data", (chunk) => {
      try { result = decoder.push(chunk)[0] ?? result; } catch (error) { reject(error); }
    });
    socket.on("error", reject);
    socket.on("close", () => result ? resolve(result) : reject(new Error("desktop response missing")));
  });
}
