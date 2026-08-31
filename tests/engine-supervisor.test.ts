import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EngineSupervisor,
  engineFeatureEnabled,
  verifyEngineBinary,
  type EngineClientLike,
} from "../apps/bridge/src/engine/engine-supervisor";
import { engineHealth } from "../apps/bridge/src/engine/engine-health";
import { EngineProtocolError, type EngineResult } from "../apps/bridge/src/engine/engine-protocol";

test("engine rollout is opt-in", () => {
  assert.equal(engineFeatureEnabled({}), false);
  assert.equal(engineFeatureEnabled({ GRANTTAP_ENGINE_ENABLED: "true" }), true);
  assert.equal(engineFeatureEnabled({ GRANTTAP_ENGINE_ENABLED: "1" }), true);
  assert.equal(engineFeatureEnabled({ GRANTTAP_ENGINE_ENABLED: "false" }), false);
});

test("supervisor accepts only an executable with the expected SHA-256", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-engine-supervisor-"));
  const binary = join(directory, "granttap-engine");
  const contents = Buffer.from("verified engine binary");
  await writeFile(binary, contents);
  await chmod(binary, 0o700);
  const checksum = createHash("sha256").update(contents).digest("hex");
  try {
    assert.equal((await verifyEngineBinary(binary, checksum)).sha256, checksum);
    await assert.rejects(verifyEngineBinary(binary, "0".repeat(64)), /checksum/i);
    await assert.rejects(verifyEngineBinary("relative/engine", checksum), /absolute/i);
    await assert.rejects(verifyEngineBinary(binary, "bad"), /checksum is invalid/i);
    await chmod(binary, 0o600);
    await assert.rejects(verifyEngineBinary(binary, checksum));
    await chmod(binary, 0o700);
    const link = join(directory, "engine-link");
    await symlink(binary, link);
    await assert.rejects(verifyEngineBinary(link, checksum), /regular file/i);
    const folder = join(directory, "folder");
    await mkdir(folder);
    await assert.rejects(verifyEngineBinary(folder, checksum), /regular file/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("health projection is timestamped without inventing engine details", () => {
  assert.deepEqual(engineHealth("healthy", { engineVersion: "0.1.0" }, 42), {
    state: "healthy",
    checkedAt: 42,
    engineVersion: "0.1.0",
  });
});

test("supervisor reports disabled and unavailable fallback without launching", async () => {
  let requests = 0;
  const client = fakeClient(async () => {
    requests += 1;
    throw new Error("offline");
  });
  const disabled = new EngineSupervisor({ env: {}, client, now: () => 10 });
  assert.equal((await disabled.ensureAvailable()).state, "disabled");
  assert.equal(requests, 0);

  const unavailable = new EngineSupervisor({
    env: { GRANTTAP_ENGINE_ENABLED: "1" },
    client,
    now: () => 11,
  });
  const health = await unavailable.ensureAvailable();
  assert.equal(health.state, "unavailable");
  assert.match(health.reason ?? "", /not configured/i);
});

test("supervisor reports a running compatible or incompatible engine", async () => {
  const healthy = new EngineSupervisor({
    env: { GRANTTAP_ENGINE_ENABLED: "true" },
    client: fakeClient(async () => ({ operation: "engine.pong", engine_version: "0.1.0" })),
    now: () => 20,
  });
  assert.deepEqual(await healthy.ensureAvailable(), {
    state: "healthy",
    checkedAt: 20,
    engineVersion: "0.1.0",
  });

  const incompatible = new EngineSupervisor({
    env: { GRANTTAP_ENGINE_ENABLED: "true" },
    client: fakeClient(async () => { throw new EngineProtocolError("future protocol"); }),
    now: () => 21,
  });
  assert.equal((await incompatible.ensureAvailable()).state, "incompatible");
});

test("supervisor verifies, launches, reaches health, and stops its child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-engine-launch-"));
  const binary = join(directory, "granttap-engine");
  const contents = Buffer.from("launchable engine");
  await writeFile(binary, contents);
  await chmod(binary, 0o700);
  const checksum = createHash("sha256").update(contents).digest("hex");
  let calls = 0;
  let closed = false;
  let killed = false;
  const client = fakeClient(async () => {
    calls += 1;
    if (calls === 1) throw new Error("not started");
    return { operation: "engine.pong", engine_version: "0.1.0" };
  }, () => { closed = true; });
  const child = Object.assign(new EventEmitter(), {
    kill: () => { killed = true; return true; },
  }) as unknown as ChildProcess;
  let launchedSocket = "";
  const supervisor = new EngineSupervisor({
    env: {
      GRANTTAP_ENGINE_ENABLED: "1",
      GRANTTAP_ENGINE_BINARY: binary,
      GRANTTAP_ENGINE_SHA256: checksum,
    },
    socketPath: join(directory, "engine.sock"),
    client,
    launch: (_path, socket) => { launchedSocket = socket; return child; },
    now: () => 30,
  });
  try {
    assert.equal((await supervisor.ensureAvailable()).state, "healthy");
    assert.equal(launchedSocket, join(directory, "engine.sock"));
    supervisor.stop();
    assert.equal(closed, true);
    assert.equal(killed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed launch enters bounded backoff", async () => {
  let now = 100;
  const supervisor = new EngineSupervisor({
    env: {
      GRANTTAP_ENGINE_ENABLED: "1",
      GRANTTAP_ENGINE_BINARY: "/missing/granttap-engine",
      GRANTTAP_ENGINE_SHA256: "0".repeat(64),
    },
    client: fakeClient(async () => { throw new Error("offline"); }),
    now: () => now,
  });
  assert.equal((await supervisor.ensureAvailable()).state, "unavailable");
  now = 101;
  assert.equal((await supervisor.ensureAvailable()).state, "backoff");
  supervisor.stop();
});

function fakeClient(
  request: () => Promise<EngineResult>,
  close = () => undefined,
): EngineClientLike {
  return { request, close };
}
