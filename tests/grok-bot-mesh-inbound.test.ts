import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateTransferKey } from "../packages/core/crypto";
import { RelayClient } from "../packages/core/relay-client";
import type { MeshEndpointPolicy, MeshEvent, MeshSnapshot } from "../packages/protocol/schema";
import { createPairing } from "../apps/bridge/src/config";
import { loadGrokBotEndpoint } from "../apps/bridge/src/mesh/endpoint";
import { localMeshStore, resetLocalMeshStore } from "../apps/bridge/src/mesh/local";
import { grokBotRelay, resetGrokBotRelay } from "../apps/mcp/src/mcp-tools/mesh-relay";
import { forwardingRelay, waitFor } from "./support/forwarding-relay";
import { saveTestGrokBotEndpoint } from "./support/grok-bot-endpoint";

const projectId = "allowed-project";
const foreignProjectId = "foreign-project";
const taskId = "inbound-task";
const actorId = "qa";

function snapshot(target: string, createdAt: number): MeshSnapshot {
  return {
    type: "mesh.snapshot", sessionId: target, projectId: target,
    project: {
      projectId: target, name: "GrantTap", repositoryRoot: "/repo",
      canonicalRepositoryId: "github.com/example/granttap", createdAt,
    },
    tasks: [{
      taskId, projectId: target, title: "Inbound", goal: "Merge scoped state",
      state: "working", createdAt, updatedAt: createdAt,
    }],
    executions: [], claims: [], dependencies: [], events: [], generatedAt: createdAt,
  };
}

function progress(target: string, createdAt: number): MeshEvent {
  return {
    type: "mesh.event", sessionId: taskId, eventId: `progress-${target}`,
    projectId: target, taskId, sourceSessionId: "claude-source",
    eventType: "TASK_PROGRESS", createdAt, expiresAt: createdAt + 86_400_000,
    payload: { summary: `Forwarded for ${target}` },
  };
}

test("Grok Bot merges only in-scope forwarded state and stops on revocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-inbound-"));
  const relay = await forwardingRelay();
  const paired = createPairing(relay.url);
  const createdAt = Date.now();
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetLocalMeshStore();
  resetGrokBotRelay();
  t.after(async () => {
    resetGrokBotRelay();
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
    await relay.close();
  });
  saveTestGrokBotEndpoint({
    pairing: paired.machineCfg, projectIds: [projectId], actorId, createdAt,
  });

  const bot = await grokBotRelay();
  assert.equal(bot, await grokBotRelay());
  const phone = new RelayClient(paired.phoneCfg);
  await phone.connect();
  t.after(() => phone.close());
  await waitFor(() => relay.connections() === 2);

  for (const sessionId of [projectId, foreignProjectId, taskId]) {
    const key = generateTransferKey();
    phone.setSessionKey(sessionId, key);
    await phone.send({
      type: "session.key.grant", sessionId, key, purpose: "project", createdAt: Date.now(),
    }, "machine");
  }
  await waitFor(() => bot.hasSessionKey(taskId));

  await phone.sendSession(snapshot(projectId, createdAt), projectId, "machine");
  await waitFor(() => localMeshStore().snapshot(projectId)?.tasks.length === 1);
  await phone.sendSession(progress(projectId, createdAt), taskId, "machine");
  await waitFor(() => (localMeshStore().snapshot(projectId)?.events.length ?? 0) === 1);

  await phone.sendSession(snapshot(foreignProjectId, createdAt), foreignProjectId, "machine");
  await phone.sendSession(progress(foreignProjectId, createdAt), taskId, "machine");
  await phone.sendSession(snapshot(projectId, createdAt + 1), projectId, "machine");
  await waitFor(() => localMeshStore().projectIds().length >= 1);
  assert.deepEqual(localMeshStore().projectIds(), [projectId]);
  assert.equal(localMeshStore().snapshot(foreignProjectId), undefined);
  assert.equal(localMeshStore().snapshot(projectId)?.events.length, 1);

  const revoked: MeshEndpointPolicy = {
    type: "mesh.endpoint.policy", endpointId: "grok-cloud", credentialId: "credential",
    enabled: true, status: "revoked", projectIds: [projectId],
    actors: [{ actorId, enabled: true }], revision: 2, createdAt: createdAt + 2,
  };
  await phone.send(revoked, "machine");
  await waitFor(() => loadGrokBotEndpoint()?.credential.status === "revoked");
  await assert.rejects(grokBotRelay(), /revoked/);
});
