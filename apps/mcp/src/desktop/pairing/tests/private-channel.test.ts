import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDesktopEngineBridge } from "../../engine-bridge";
import { encodeEngineFrame } from "../../../../../bridge/src/engine/protocol/engine-protocol";
import { loadConfig, machineConfigPath } from "../../../../../bridge/src/config";

function request(socketPath: string, input: object): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = Buffer.alloc(0);
    socket.on("connect", () => socket.write(encodeEngineFrame({ protocol_version: 1,
      request_id: "enrollment-test", operation: "desktop.controller_enrollment", input })));
    socket.on("data", (chunk) => { data = Buffer.concat([data, chunk]); });
    socket.on("close", () => resolve(data.length ? JSON.parse(data.subarray(4).toString()).result : undefined));
    socket.on("error", reject);
  });
}

test("native Settings creates a first pairing through the private same-user socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-native-enrollment-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  const server = createServer((req, res) => { req.resume(); res.writeHead(200); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GRANTTAP_TEST_RELAY_URL = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  let changes = 0;
  const bridge = await startDesktopEngineBridge({ onPairingChanged: () => { changes++; },
    client: { request: async () => { throw new Error("enrollment must not invoke Engine"); }, close() {} },
  });
  t.after(async () => {
    await bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.GRANTTAP_TEST_RELAY_URL;
    delete process.env.GRANTTAP_CONFIG_DIR;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await stat(bridge.socketPath)).mode & 0o777, 0o600);
  assert.equal((await request(bridge.socketPath, { action: "status" }))?.status, "idle");
  assert.equal(await request(bridge.socketPath, { action: "create" }), undefined);
  const issued = await request(bridge.socketPath, { action: "create", confirmed: "true" });
  assert.equal(issued?.status, "pending");
  assert.match(issued?.uri as string, /^granttap:\/\/pair-v2\?/);
  assert.equal(changes, 1);
  assert.equal(loadConfig(machineConfigPath()).role, "machine");
  assert.equal((await request(bridge.socketPath, { action: "status" }))?.uri, issued?.uri);
});
