import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateTransferKey, sealWithTransferKey } from "../packages/core/crypto";
import type { PeerConfig } from "../packages/core/relay-client";
import {
  applyGrokBotPolicy,
  authorizeGrokBotOperation,
  connectGrokBotInvite,
  grokBotEndpointPath,
  hasGrokBotEndpoint,
  loadGrokBotEndpoint,
  saveGrokBotEndpoint,
  type GrokBotEndpointBundle,
} from "../apps/bridge/src/mesh/endpoint";
import { localMeshStore, resetLocalMeshStore } from "../apps/bridge/src/mesh/local";

const now = 1_800_000_000_000;

function pairing(): PeerConfig & { role: "machine" } {
  return {
    relayUrl: "ws://127.0.0.1:8787", room: "a".repeat(32), role: "machine",
    deviceName: "Grok Bot Cloud", senderId: "bot", myPublicKey: Buffer.alloc(32, 1).toString("base64"),
    mySecretKey: Buffer.alloc(32, 2).toString("base64"),
    peerPublicKey: Buffer.alloc(32, 3).toString("base64"), pushAuth: "b".repeat(64),
  };
}

function bundle(): GrokBotEndpointBundle {
  return {
    version: 1,
    endpoint: {
      endpointId: "grok-cloud", kind: "grok_bot_cloud", displayName: "Grok Bot Cloud",
      publicKey: Buffer.alloc(32, 1).toString("base64url"), credentialId: "credential",
      status: "active", createdAt: now,
    },
    credential: {
      credentialId: "credential", endpointId: "grok-cloud", status: "active",
      projectIds: ["project"], operations: ["status", "task", "progress", "handoff"],
      issuedAt: now, expiresAt: now + 86_400_000,
    },
    actors: [{
      actorId: "qa", endpointId: "grok-cloud", kind: "persistent_agent",
      displayName: "QA Bot", status: "idle", enabled: true,
    }],
    pairing: pairing(),
    policy: {
      type: "mesh.endpoint.policy", endpointId: "grok-cloud", credentialId: "credential",
      enabled: true, status: "active", projectIds: ["project"],
      actors: [{ actorId: "qa", enabled: true }], revision: 1, createdAt: now,
    },
    inviteExpiresAt: now + 600_000,
  };
}

test("Grok Bot endpoint authorization fails closed by actor, scope, operation, and revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-endpoint-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  saveGrokBotEndpoint(bundle());
  assert.equal(loadGrokBotEndpoint()?.endpoint.endpointId, "grok-cloud");
  assert.doesNotThrow(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", operation: "progress", now,
  }));
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "missing", projectId: "project", operation: "progress", now,
  }), /actor/i);
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "other", operation: "progress", now,
  }), /project scope/i);
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", operation: "complete", now,
  }), /operation/i);

  applyGrokBotPolicy({ ...bundle().policy, status: "revoked", enabled: false, revision: 2 });
  assert.equal(loadGrokBotEndpoint()?.credential.status, "revoked");
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", operation: "status", now,
  }), /revoked/i);
  delete process.env.GRANTTAP_CONFIG_DIR;
});

test("trusted CLI consumes one encrypted one-time Mesh Invite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-invite-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  const key = generateTransferKey();
  const sealed = sealWithTransferKey(bundle(), key);
  let gets = 0;
  const server = createServer((request, response) => {
    if (request.url !== `/pair/${"c".repeat(32)}` || request.method !== "GET") {
      response.statusCode = 404;
      response.end();
      return;
    }
    gets += 1;
    response.statusCode = gets === 1 ? 200 : 410;
    response.setHeader("content-type", "application/json");
    response.end(gets === 1 ? JSON.stringify(sealed) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const invite = `granttap://mesh-invite?v=1&u=http%3A%2F%2F127.0.0.1%3A${address.port}`
    + `&m=${"c".repeat(32)}&k=${key}`;
  const connected = await connectGrokBotInvite(invite, now);
  assert.equal(connected.endpoint.endpointId, "grok-cloud");
  assert.equal(JSON.parse(await readFile(grokBotEndpointPath(), "utf8")).pairing.role, "machine");
  await assert.rejects(() => connectGrokBotInvite(invite, now), /already|used|expired/i);
  delete process.env.GRANTTAP_CONFIG_DIR;
});

test("endpoint policies enforce expiry, task scope, revisions, and claim revocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-policy-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetLocalMeshStore();
  t.after(() => {
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
  });
  assert.equal(loadGrokBotEndpoint(), null);
  assert.equal(hasGrokBotEndpoint(), false);
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", operation: "status", now,
  }), /not connected/);

  const scoped = bundle();
  scoped.credential.taskIds = ["allowed-task"];
  saveGrokBotEndpoint(scoped);
  assert.equal(hasGrokBotEndpoint(), true);
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", taskId: "other-task", operation: "task", now,
  }), /Task scope/);
  assert.doesNotThrow(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", taskId: "allowed-task", operation: "task", now,
  }));
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", operation: "status", now: now + 90_000_000,
  }), /expired/);

  const disabledMesh = loadGrokBotEndpoint()!;
  disabledMesh.policy.enabled = false;
  saveGrokBotEndpoint(disabledMesh);
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", operation: "status", now,
  }), /Mesh is disabled/);
  disabledMesh.policy.enabled = true;
  disabledMesh.actors[0]!.enabled = false;
  saveGrokBotEndpoint(disabledMesh);
  assert.throws(() => authorizeGrokBotOperation({
    actorId: "qa", projectId: "project", operation: "status", now,
  }), /actor is disabled/);
  disabledMesh.actors[0]!.enabled = true;
  saveGrokBotEndpoint(disabledMesh);

  assert.throws(() => applyGrokBotPolicy({
    ...disabledMesh.policy, endpointId: "other", revision: 2,
  }), /does not match/);
  applyGrokBotPolicy({ ...disabledMesh.policy, revision: 1 });
  assert.equal(loadGrokBotEndpoint()?.policy.revision, 1);

  const store = localMeshStore();
  store.upsertProject({
    projectId: "project", name: "Project", canonicalRepositoryId: "repo", createdAt: now,
  });
  store.upsertTask({
    taskId: "allowed-task", projectId: "project", title: "Task", goal: "Goal",
    state: "working", ownerSessionId: "grok-session", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: "allowed-task", sessionId: "grok-session", provider: "grok_bot", actorId: "qa",
    computerId: "grok-cloud", workspace: "/repo", startedAt: now,
  });
  store.claim({
    claimId: "claim", projectId: "project", taskId: "allowed-task",
    ownerSessionId: "grok-session", resource: "src/**", mode: "claim",
    createdAt: now, expiresAt: now + 60_000,
  });
  applyGrokBotPolicy({
    ...disabledMesh.policy, status: "revoked", enabled: false,
    actors: [{ actorId: "qa", enabled: false }], revision: 2, createdAt: now + 1,
  });
  assert.equal(store.snapshot("project")?.claims.length, 0);
  assert.equal(loadGrokBotEndpoint()?.actors[0]?.enabled, false);
});

test("Mesh Invite validation rejects untrusted URLs and malformed relay responses", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-invalid-invite-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => delete process.env.GRANTTAP_CONFIG_DIR);
  for (const invite of [
    "not-a-url",
    "granttap://wrong?v=1",
    `granttap://mesh-invite?v=1&u=http%3A%2F%2Fexample.test&m=${"c".repeat(32)}&k=${"a".repeat(43)}`,
    `granttap://mesh-invite?v=1&u=https%3A%2F%2Fu%3Ap%40example.test&m=${"c".repeat(32)}&k=${"a".repeat(43)}`,
    "granttap://mesh-invite?v=1&u=https%3A%2F%2Fexample.test&m=short&k=short",
  ]) await assert.rejects(connectGrokBotInvite(invite, now), /invalid/);

  let mode: "missing" | "error" | "malformed" = "missing";
  const server = createServer((_request, response) => {
    if (mode === "missing") response.statusCode = 404;
    else if (mode === "error") response.statusCode = 500;
    else {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
    }
    response.end(mode === "malformed" ? JSON.stringify({ nonce: 1, box: null }) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const invite = `granttap://mesh-invite?v=1&u=http%3A%2F%2F127.0.0.1%3A${address.port}`
    + `&m=${"c".repeat(32)}&k=${generateTransferKey()}`;
  await assert.rejects(connectGrokBotInvite(invite, now), /expired or was already used/);
  mode = "error";
  await assert.rejects(connectGrokBotInvite(invite, now), /HTTP 500/);
  mode = "malformed";
  await assert.rejects(connectGrokBotInvite(invite, now), /invalid/);
});
