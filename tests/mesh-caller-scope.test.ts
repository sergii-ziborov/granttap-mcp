import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPairing, machineConfigPath, saveConfig, saveRuntimeConfig,
} from "../apps/bridge/src/config";
import { recordAttributedCall } from "../apps/bridge/src/mesh/call-scope";
import { localMeshStore, resetLocalMeshStore } from "../apps/bridge/src/mesh/local";
import { createGrantTapServer, resetRelay } from "../apps/mcp/src/create-server";
import { connectInMemory, textResult } from "./support/mcp-client";
import { forwardingRelay } from "./support/forwarding-relay";

const alpha = { projectId: "project-alpha", taskId: "task-alpha", sessionId: "claude-alpha" };
const beta = { projectId: "project-beta", taskId: "task-beta", sessionId: "codex-beta" };

function seed(scope: typeof alpha, provider: "claude" | "codex", secret: string): void {
  const now = Date.now();
  const store = localMeshStore();
  store.upsertProject({
    projectId: scope.projectId, name: `Project ${scope.projectId}`, repositoryRoot: `/repo/${scope.projectId}`,
    canonicalRepositoryId: `github.com/example/${scope.projectId}`, createdAt: now,
  });
  store.upsertTask({
    taskId: scope.taskId, projectId: scope.projectId, title: secret, goal: `${secret} goal`,
    state: "working", ownerSessionId: scope.sessionId, createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: scope.taskId, sessionId: scope.sessionId, provider, computerId: "MacBook",
    workspace: `/repo/${scope.projectId}`, branch: `${provider}/secret`, startedAt: now,
  });
}

async function meshFixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-scope-"));
  const relay = await forwardingRelay();
  const paired = createPairing(relay.url);
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetRelay();
  resetLocalMeshStore();
  saveConfig(machineConfigPath(), paired.machineCfg);
  saveRuntimeConfig({ meshEnabled: true });
  seed(alpha, "claude", "Alpha release audit");
  seed(beta, "codex", "Beta payment secrets");
  t.after(async () => {
    resetRelay();
    resetLocalMeshStore();
    delete process.env.GRANTTAP_CONFIG_DIR;
    await relay.close();
  });
  const client = await connectInMemory(createGrantTapServer());
  t.after(() => client.close());
  return client;
}

function attributeAlpha(args: Record<string, unknown>): void {
  recordAttributedCall({
    provider: "claude", sessionId: alpha.sessionId,
    toolName: "mcp__granttap__notify", args,
  });
}

test("an injected session cannot publish Mesh events as another execution", async (t) => {
  const client = await meshFixture(t);
  const impersonation = {
    projectId: beta.projectId, taskId: beta.taskId, sourceSessionId: beta.sessionId,
    eventType: "TASK_COMPLETED", payload: { summary: "Payments are done" },
  };

  attributeAlpha({ meshEvent: impersonation });
  const forged = await client.callTool({ name: "notify", arguments: { meshEvent: impersonation } });
  assert.equal(forged.isError, true);
  assert.match(textResult(forged), /only for the calling execution|outside this execution/i);

  const foreignTask = {
    projectId: beta.projectId, taskId: beta.taskId,
    eventType: "TASK_PROGRESS", payload: { summary: "Reading payments" },
  };
  attributeAlpha({ meshEvent: foreignTask });
  const crossProject = await client.callTool({ name: "notify", arguments: { meshEvent: foreignTask } });
  assert.equal(crossProject.isError, true);

  const ownership = {
    projectId: alpha.projectId, taskId: alpha.taskId,
    eventType: "HANDOFF_ACCEPTED",
    payload: { receipt: {
      sourceSessionId: beta.sessionId, targetSessionId: alpha.sessionId,
      taskId: alpha.taskId, capsuleHash: "0".repeat(64), acceptedAt: Date.now(),
    } },
  };
  attributeAlpha({ meshEvent: ownership });
  const seized = await client.callTool({ name: "notify", arguments: { meshEvent: ownership } });
  assert.equal(seized.isError, true);
  assert.match(textResult(seized), /decided by GrantTap/i);

  assert.equal(
    localMeshStore().snapshot(beta.projectId)?.events.length ?? 0, 0,
    "no forged event reached the other Project",
  );
});

test("scoped Mesh reads never expose another Project", async (t) => {
  const client = await meshFixture(t);
  const own = {
    projectId: alpha.projectId, taskId: alpha.taskId,
    eventType: "TASK_PROGRESS", payload: { summary: "Auditing the release" },
  };
  attributeAlpha({ meshEvent: own });
  const published = textResult(await client.callTool({ name: "notify", arguments: { meshEvent: own } }));
  const token = /granttap:\/\/mesh\/([A-Za-z0-9_-]{43})/.exec(published)?.[1];
  assert.ok(token, "an attributed call returns this execution's scoped URI");

  // A second Task inside the caller's own Project stays identifiable for
  // dependencies and claims, without republishing its goal text.
  localMeshStore().upsertTask({
    taskId: "task-alpha-peer", projectId: alpha.projectId, title: "Alpha docs",
    goal: "Alpha private goal", state: "planned", ownerSessionId: "claude-peer",
    createdAt: Date.now(), updatedAt: Date.now(),
  });

  const scoped = await client.readResource({ uri: `granttap://mesh/${token}` });
  const view = JSON.parse((scoped.contents[0] as { text: string }).text);
  assert.equal(view.scoped, true);
  assert.equal(view.project.projectId, alpha.projectId);
  assert.equal(view.task.taskId, alpha.taskId);
  assert.equal(view.execution.sessionId, alpha.sessionId);
  assert.deepEqual(view.peerTasks.map((item: { taskId: string }) => item.taskId), ["task-alpha-peer"]);
  assert.equal(view.peerTasks[0].title, "Alpha docs");
  assert.doesNotMatch(JSON.stringify(view.peerTasks), /Alpha private goal/);
  assert.equal(view.events.some((event: { sourceSessionId: string }) =>
    event.sourceSessionId === alpha.sessionId), true);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /Beta payment secrets/);

  // The same Project as one page of markdown, scoped the same way.
  const map = await client.readResource({ uri: `granttap://mesh/${token}/map` });
  const page = (map.contents[0] as { text: string; mimeType: string });
  assert.equal(page.mimeType, "text/markdown");
  assert.match(page.text, /^# Project Mesh — Project project-alpha\n/);
  assert.match(page.text, /\*\*Alpha docs\*\* — planned/);
  assert.doesNotMatch(page.text, /Beta payment secrets|project-beta/);
  const unscopedMap = await client.readResource({ uri: "granttap://mesh/current/map" });
  assert.match((unscopedMap.contents[0] as { text: string }).text, /Project Mesh reads are scoped to one execution/);
  assert.doesNotMatch(serialized, new RegExp(beta.sessionId));
  assert.doesNotMatch(serialized, new RegExp(beta.projectId));

  const capability = { ...own, capability: token, payload: { summary: "Second update" } };
  recordAttributedCall({ provider: "claude", sessionId: "unknown-session",
    toolName: "mcp__granttap__notify", args: { meshEvent: capability } });
  const wrongSession = await client.callTool({ name: "notify", arguments: { meshEvent: capability } });
  assert.equal(wrongSession.isError, true, "a capability never rescues an unknown caller");
});

test("a server that knows its chat from the environment serves that chat's map, and only that", async (t) => {
  const previous = process.env.CLAUDE_CODE_SESSION_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previous;
  });
  process.env.CLAUDE_CODE_SESSION_ID = alpha.sessionId;
  const client = await meshFixture(t);

  const listed = await client.listResources();
  assert.ok(listed.resources.some((resource) => resource.uri === "granttap://mesh/map"), "listed, so a client that reads only listed resources can open it");
  const map = String(((await client.readResource({ uri: "granttap://mesh/map" })).contents[0] as { text?: string })?.text ?? "");
  assert.match(map, /Alpha release audit/);
  assert.doesNotMatch(map, /Beta payment secrets/, "another Project never appears");

  const current = JSON.parse(String(((await client.readResource({ uri: "granttap://mesh/current" })).contents[0] as { text?: string })?.text ?? "{}"));
  assert.equal(current.scoped, true);
  assert.equal(current.project?.projectId ?? current.projectId, "project-alpha");

  // A chat the Mesh does not know gets directions, not data.
  process.env.CLAUDE_CODE_SESSION_ID = "nobody-knows-this-chat";
  const unknown = String(((await client.readResource({ uri: "granttap://mesh/map" })).contents[0] as { text?: string })?.text ?? "");
  assert.match(unknown, /^# Project Mesh\n\nProject Mesh reads are scoped to one execution\./);
  assert.doesNotMatch(unknown, /Alpha release audit|Beta payment secrets/);
});
