import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayClient } from "../packages/core/relay-client";
import type { Payload } from "../packages/protocol/schema";
import {
  createPairing, machineConfigPath, saveConfig, saveRuntimeConfig,
} from "../apps/bridge/src/config";
import { recordAttributedCall } from "../apps/bridge/src/mesh/call-scope";
import { localMeshStore, resetLocalMeshStore } from "../apps/bridge/src/mesh/local";
import { createGrantTapServer, resetRelay } from "../apps/mcp/src/create-server";
import { connectInMemory, textResult } from "./support/mcp-client";
import { forwardingRelay, waitFor } from "./support/forwarding-relay";

const projectId = "project";
const taskId = "task";

function seedSource(): void {
  const now = Date.now();
  const store = localMeshStore();
  store.upsertProject({
    projectId, name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  });
  store.upsertTask({
    taskId, projectId, title: "Pairing", goal: "Fix reconnect", state: "working",
    ownerSessionId: "claude-session", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId, sessionId: "claude-session", provider: "claude", computerId: "MacBook",
    workspace: "/repo", branch: "claude/reconnect", startedAt: now,
  });
}

test("in-process MCP covers unpaired interaction behavior", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-unpaired-mcp-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetRelay();
  resetLocalMeshStore();
  t.after(() => {
    resetRelay();
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
  });
  const client = await connectInMemory(createGrantTapServer());
  t.after(() => client.close());
  const notify = await client.callTool({ name: "notify", arguments: { message: "hello" } });
  assert.match(textResult(notify), /not paired/i);
  const yesNo = await client.callTool({ name: "ask_yes_no", arguments: { question: "Ready?" } });
  assert.match(textResult(yesNo), /not paired/i);
  const open = await client.callTool({ name: "ask", arguments: { question: "Status?" } });
  assert.match(textResult(open), /not paired/i);
  const resource = await client.readResource({ uri: "granttap://mesh/current" });
  const value = JSON.parse((resource.contents[0] as { text: string }).text);
  assert.equal(value.enabled, true);
  assert.equal(value.scoped, false);
  assert.equal("projects" in value, false);
});

test("paired MCP delivers decisions, replies, and bounded Mesh events", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-paired-mcp-"));
  const relay = await forwardingRelay();
  const paired = createPairing(relay.url);
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetRelay();
  resetLocalMeshStore();
  saveConfig(machineConfigPath(), paired.machineCfg);
  saveRuntimeConfig({ meshEnabled: true });
  seedSource();
  t.after(async () => {
    resetRelay();
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
    await relay.close();
  });

  const received: Payload[] = [];
  const phone = new RelayClient(paired.phoneCfg);
  phone.onMessage(async (payload) => {
    received.push(payload);
    if (payload.type === "approval.request") {
      await phone.send({
        type: "approval.decision", requestId: payload.requestId,
        decision: "allow", sessionId: payload.sessionId,
        decidedAt: Date.now(), decidedBy: "phone",
      }, "machine");
    }
    if (payload.type === "agent.event" && payload.kind === "question" && payload.requestId) {
      await phone.send({
        type: "user.message", messageId: "reply-message", requestId: payload.requestId,
        text: "connectionId", sessionId: payload.sessionId, createdAt: Date.now(),
      }, "machine");
    }
    return true;
  });
  await phone.connect();
  t.after(() => phone.close());
  const client = await connectInMemory(createGrantTapServer());
  t.after(() => client.close());
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  assert.equal(textResult(await call("notify", { message: "Build started" })), "sent to phone");
  recordAttributedCall({
    provider: "claude", sessionId: "claude-session",
    toolName: "mcp__granttap__ask_yes_no", args: { question: "Continue?" },
  });
  assert.equal(textResult(await call("ask_yes_no", { question: "Continue?" })), "yes");
  recordAttributedCall({
    provider: "claude", sessionId: "claude-session",
    toolName: "mcp__granttap__ask", args: { question: "Field name?" },
  });
  assert.equal(textResult(await call("ask", { question: "Field name?" })), "connectionId");
  const yesNoRequest = received.find((item) => item.type === "approval.request") as
    Extract<Payload, { type: "approval.request" }> | undefined;
  const openQuestion = received.find((item) =>
    item.type === "agent.event" && item.kind === "question") as
      Extract<Payload, { type: "agent.event" }> | undefined;
  assert.equal(yesNoRequest?.sessionId, "claude-session");
  assert.equal(yesNoRequest?.agent, "claude");
  assert.equal(openQuestion?.sessionId, "claude-session");
  assert.equal(openQuestion?.projectId, projectId);
  assert.equal(openQuestion?.taskId, taskId);

  const meshInput = {
    projectId, taskId, sourceSessionId: "claude-session",
    eventType: "TASK_PROGRESS", payload: { summary: "Crypto complete" },
  };
  // Stand in for the provider hook, which is the only trusted place that knows
  // which session made the call.
  const attribute = (args: Record<string, unknown>) => recordAttributedCall({
    provider: "claude", sessionId: "claude-session",
    toolName: "mcp__granttap__notify", args,
  });

  assert.equal((await call("notify", { meshEvent: meshInput })).isError, true,
    "an unattributed Mesh event publishes nothing");
  attribute({ meshEvent: meshInput });
  const published = textResult(await call("notify", { meshEvent: meshInput }));
  assert.match(published, /mesh event published/);
  assert.match(published, /granttap:\/\/mesh\/[A-Za-z0-9_-]{43}/);
  saveRuntimeConfig({ meshEnabled: false });
  attribute({ meshEvent: meshInput });
  assert.equal((await call("notify", { meshEvent: meshInput })).isError, true);
  const disabledResource = await client.readResource({ uri: "granttap://mesh/current" });
  const disabled = JSON.parse((disabledResource.contents[0] as { text: string }).text);
  assert.equal(disabled.enabled, false);
  assert.equal("projects" in disabled, false);

  saveRuntimeConfig({ meshEnabled: true, providerSettings: {
    claude: false, codex: true, cursor: true, grok: true,
  } });
  attribute({ meshEvent: meshInput });
  assert.equal((await call("notify", { meshEvent: meshInput })).isError, true);
  saveRuntimeConfig({ providerSettings: { claude: true, codex: true, cursor: true, grok: true } });
  localMeshStore().claim({
    claimId: "foreign", projectId, taskId, ownerSessionId: "codex-session",
    resource: "src/auth/**", mode: "claim", createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  });
  const claimEvent = {
    ...meshInput, eventType: "RESOURCE_CLAIM", payload: { claim: {
      claimId: "local", projectId, taskId, ownerSessionId: "claude-session",
      resource: "src/auth/login.ts", mode: "claim", createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    } },
  };
  attribute({ meshEvent: claimEvent });
  const conflict = await call("notify", { meshEvent: claimEvent });
  assert.match(textResult(conflict), /claim rejected/);
  await waitFor(() => received.some((item) => item.type === "mesh.event"));
});
