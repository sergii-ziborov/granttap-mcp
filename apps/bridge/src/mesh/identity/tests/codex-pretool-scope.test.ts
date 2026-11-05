import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPairing, machineConfigPath, saveConfig, saveRuntimeConfig } from "../../../config";
import { consumeAttributedCall } from "../call-scope";
import { localMeshStore, resetLocalMeshStore } from "../../local-remote/local";
import { createGrantTapServer, resetRelay } from "../../../../../mcp/src/http/create-server";
import { runProjectHook } from "../../../../../../tests/project-policy-hook-harness";
import { forwardingRelay } from "../../../../../../tests/support/forwarding-relay";
import { connectInMemory, textResult } from "../../../../../../tests/support/mcp-client";

const sessionId = "codex-pretool-chat";
const arguments_ = { meshEvent: { projectId: "project-pretool", taskId: "task-pretool",
  eventType: "TASK_PROGRESS", payload: { summary: "Checking the release" } }, operationId: "pretool-scope" };

async function fixture(t: TestContext) {
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  const claudeSession = process.env.CLAUDE_CODE_SESSION_ID;
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-pretool-"));
  const nativeRoots = ["GRANTTAP_CODEX_DIR", "GRANTTAP_CODEX_SESSIONS_DIR", "GRANTTAP_CLAUDE_PROJECTS_DIR",
    "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", "GRANTTAP_CURSOR_STATE_DB", "GRANTTAP_GROK_DIR", "GRANTTAP_GROK_SESSIONS_DIR"];
  const nativeBefore = nativeRoots.map(key => process.env[key]);
  for (const key of nativeRoots) process.env[key] = join(root, key);
  const relay = await forwardingRelay();
  process.env.GRANTTAP_CONFIG_DIR = root;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  resetRelay();
  resetLocalMeshStore();
  saveConfig(machineConfigPath(), createPairing(relay.url).machineCfg);
  saveRuntimeConfig({ meshEnabled: true });
  const store = localMeshStore(), now = Date.now();
  store.upsertProject({ projectId: "project-pretool", name: "Release",
    repositoryRoot: "/repo/release", canonicalRepositoryId: "example.test/release", createdAt: now });
  store.upsertTask({ projectId: "project-pretool", taskId: "task-pretool", title: "Release check",
    goal: "Verify release", state: "working", ownerSessionId: sessionId, createdAt: now, updatedAt: now });
  store.linkExecution({ taskId: "task-pretool", sessionId, provider: "codex", computerId: "Mac",
    workspace: "/repo/release", startedAt: now });
  t.after(async () => {
    resetRelay();
    resetLocalMeshStore();
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    if (claudeSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = claudeSession;
    nativeRoots.forEach((key, i) => {
      if (nativeBefore[i] === undefined) delete process.env[key];
      else process.env[key] = nativeBefore[i];
    });
    await relay.close();
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function preTool(root: string, overrides: Record<string, unknown> = {}) {
  return runProjectHook("codexPolicy", root, {
    hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: "call-notify",
    tool_name: "mcp__granttap__notify", tool_input: arguments_, ...overrides,
  }, { GRANTTAP_ENGINE_ENABLED: "0", GRANTTAP_PROJECT_POLICY_ENABLED: "0" });
}

test("an allowed Codex MCP call gets its Mesh scope without a PermissionRequest", async t => {
  const root = await fixture(t);
  assert.equal(preTool(root).stdout, "", "PreToolUse must not wait for phone approval");
  const client = await connectInMemory(createGrantTapServer());
  t.after(() => client.close());
  const result = await client.callTool({ name: "notify", arguments: arguments_ });
  assert.notEqual(result.isError, true);
  const uri = /granttap:\/\/mesh\/[A-Za-z0-9_-]{43}/.exec(textResult(result))?.[0];
  assert.ok(uri, "PreToolUse alone must bind a normally allowed MCP call to this chat");
  const resource = await client.readResource({ uri });
  const view = JSON.parse(String((resource.contents[0] as { text: string }).text));
  assert.equal(view.scoped, true);
  assert.equal(view.task.taskId, "task-pretool");
  assert.equal(view.execution.sessionId, sessionId);
  assert.equal(consumeAttributedCall("notify", arguments_), undefined, "attribution is single-use");
  const forged = await client.callTool({ name: "notify", arguments: {
    meshEvent: { projectId: "project-pretool", taskId: "task-pretool", sourceSessionId: sessionId,
      eventType: "TASK_COMPLETED", payload: { summary: "Forged completion" } },
  } });
  assert.equal(forged.isError, true, "naming a session cannot replace trusted hook attribution");
});

test("denied, disabled and unbound calls never obtain Codex Mesh attribution", async t => {
  const root = await fixture(t);
  saveRuntimeConfig({ sessionMcpDisabled: { [sessionId]: ["granttap"] } });
  assert.equal(preTool(root).value?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(consumeAttributedCall("notify", arguments_), undefined);
  saveRuntimeConfig({ sessionMcpDisabled: {}, providerSettings: { claude: true, codex: false, cursor: true, grok: true } });
  assert.equal(preTool(root).stdout, "");
  assert.equal(consumeAttributedCall("notify", arguments_), undefined);
  saveRuntimeConfig({ providerSettings: { claude: true, codex: true, cursor: true, grok: true } });
  assert.equal(preTool(root, { session_id: undefined }).stdout, "");
  assert.equal(consumeAttributedCall("notify", arguments_), undefined);
  assert.equal(preTool(root, { tool_name: "mcp__filesystem__read_file" }).stdout, "");
  assert.equal(consumeAttributedCall("notify", arguments_), undefined);
});
