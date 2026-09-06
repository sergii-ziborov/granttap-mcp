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

// Under Claude Code the shell carries the chat's own id, and a server that
// knows its chat attributes calls to that chat alone. Here the fixture's
// sessions are the chats, so an inherited id must not speak for them.
delete process.env.CLAUDE_CODE_SESSION_ID;

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
  // Not paired is an error, not an outcome: nothing was sent, nothing was asked.
  const notify = await client.callTool({ name: "notify", arguments: { message: "hello" } });
  assert.match(textResult(notify), /not paired/i);
  assert.equal(notify.isError, true);
  const yesNo = await client.callTool({ name: "ask_yes_no", arguments: { question: "Ready?" } });
  assert.match(textResult(yesNo), /not paired/i);
  assert.equal(yesNo.isError, true);
  const open = await client.callTool({ name: "ask", arguments: { question: "Status?" } });
  assert.match(textResult(open), /not paired/i);
  assert.equal(open.isError, true);
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

  // Every outcome is also structured, so a model can branch on it without
  // parsing prose: what was sent, what was decided, and whether anyone answered.
  const status = await call("notify", { message: "Build started" });
  assert.equal(textResult(status), "sent to phone");
  assert.deepEqual(status.structuredContent, { status: "sent", messageSent: true });
  recordAttributedCall({
    provider: "claude", sessionId: "claude-session",
    toolName: "mcp__granttap__ask_yes_no", args: { question: "Continue?" },
  });
  const decided = await call("ask_yes_no", { question: "Continue?" });
  assert.equal(textResult(decided), "yes");
  assert.deepEqual(decided.structuredContent, { status: "answered", decision: "yes" });
  // Named, a call asked again is answered from memory: the person is not asked twice.
  const asked = () => received.filter((item) => item.type === "approval.request").length;
  const before = asked();
  recordAttributedCall({ provider: "claude", sessionId: "claude-session", toolName: "mcp__granttap__ask_yes_no", args: { question: "Deploy?" } });
  const first = await call("ask_yes_no", { question: "Deploy?", operationId: "deploy-1" });
  assert.deepEqual(first.structuredContent, { status: "answered", decision: "yes" });
  assert.equal(asked(), before + 1);
  const again = await call("ask_yes_no", { question: "Deploy?", operationId: "deploy-1" });
  assert.deepEqual(again.structuredContent, { status: "answered", decision: "yes", replayed: true });
  assert.match(textResult(again), /replayed/);
  assert.equal(asked(), before + 1, "asked once");
  const statuses = () => received.filter((item) => item.type === "agent.event" && item.kind === "status").length;
  const sentBefore = statuses();
  const noted = await call("notify", { message: "Deploying", operationId: "note-1" });
  assert.deepEqual(noted.structuredContent, { status: "sent", messageSent: true });
  const notedAgain = await call("notify", { message: "Deploying", operationId: "note-1" });
  assert.deepEqual(notedAgain.structuredContent, { status: "sent", messageSent: true, replayed: true });
  await waitFor(() => statuses() >= sentBefore + 1);
  assert.equal(statuses(), sentBefore + 1, "one status text reached the phone");
  recordAttributedCall({
    provider: "claude", sessionId: "claude-session",
    toolName: "mcp__granttap__ask", args: { question: "Field name?" },
  });
  const answered = await call("ask", { question: "Field name?" });
  assert.equal(textResult(answered), "connectionId");
  assert.deepEqual(answered.structuredContent, { status: "answered", answer: "connectionId" });
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
  const publishedResult = await call("notify", { meshEvent: meshInput });
  const published = textResult(publishedResult);
  assert.match(published, /mesh event published/);
  assert.match(published, /granttap:\/\/mesh\/[A-Za-z0-9_-]{43}/);
  const publishedOutcome = publishedResult.structuredContent as Record<string, unknown>;
  assert.equal(publishedOutcome.status, "published");
  assert.equal(publishedOutcome.messageSent, false);
  assert.match(String(publishedOutcome.meshEventId), /^[0-9a-f-]{36}$/, "the recorded event's id, so a retry is not a duplicate");
  assert.match(String(publishedOutcome.scopedResource), /^granttap:\/\/mesh\/[A-Za-z0-9_-]{43}$/);
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
  const conflictOutcome = conflict.structuredContent as Record<string, unknown>;
  assert.equal(conflictOutcome.status, "claim_rejected");
  assert.deepEqual(conflictOutcome.conflict, { ownerSessionId: "codex-session", resource: "src/auth/**" });
  await waitFor(() => received.some((item) => item.type === "mesh.event"));
});
