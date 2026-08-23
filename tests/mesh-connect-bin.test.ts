import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateTransferKey, sealWithTransferKey } from "../packages/core/crypto";
import type { GrokBotEndpointBundle } from "../apps/bridge/src/mesh/endpoint";

function run(args: string[], config: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/bridge/src/bin/mesh-connect.ts", ...args], {
    cwd: process.cwd(), env: { ...process.env, GRANTTAP_CONFIG_DIR: config },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

test("trusted Mesh connect entry validates arguments and consumes one invite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-connect-bin-"));
  const usage = await run([], root);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /Usage/);
  const invalid = await run(["not-an-invite"], root);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /connection failed/);

  const now = Date.now();
  const key = generateTransferKey();
  const bundle: GrokBotEndpointBundle = {
    version: 1,
    endpoint: {
      endpointId: "grok-cloud", kind: "grok_bot_cloud", displayName: "Grok Bot Cloud",
      publicKey: Buffer.alloc(32, 1).toString("base64url"), credentialId: "credential",
      status: "active", createdAt: now,
    },
    credential: {
      credentialId: "credential", endpointId: "grok-cloud", status: "active",
      projectIds: ["project"], operations: ["status"], issuedAt: now, expiresAt: now + 86_400_000,
    },
    actors: [{
      actorId: "qa", endpointId: "grok-cloud", kind: "persistent_agent",
      displayName: "QA Bot", status: "idle", enabled: true,
    }],
    pairing: {
      relayUrl: "wss://relay.granttap.app", room: "a".repeat(32), role: "machine",
      deviceName: "Grok Bot Cloud", senderId: "grok-cloud",
      myPublicKey: Buffer.alloc(32, 1).toString("base64"),
      mySecretKey: Buffer.alloc(32, 2).toString("base64"),
      peerPublicKey: Buffer.alloc(32, 3).toString("base64"), pushAuth: "b".repeat(64),
    },
    policy: {
      type: "mesh.endpoint.policy", endpointId: "grok-cloud", credentialId: "credential",
      enabled: true, status: "active", projectIds: ["project"],
      actors: [{ actorId: "qa", enabled: true }], revision: 1, createdAt: now,
    },
    inviteExpiresAt: now + 600_000,
  };
  const sealed = sealWithTransferKey(bundle, key);
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(sealed));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const invite = `granttap://mesh-invite?v=1&u=http%3A%2F%2F127.0.0.1%3A${address.port}`
    + `&m=${"c".repeat(32)}&k=${key}`;
  const connected = await run([invite], root);
  assert.equal(connected.code, 0, connected.stderr);
  assert.match(connected.stdout, /Grok Bot endpoint  Connected/);
  assert.match(connected.stdout, /Actors             1/);
});
