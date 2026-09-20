/**
 * What the Mesh audit found, and what now holds instead.
 *
 * Each test here is one finding: a claim released by a stranger, a handoff
 * started by an agent, two processes writing one file, a store file quietly
 * replaced, a rejoined chat whose events no longer parsed, a prompt that
 * marked unread what it never showed, a tool call attributed to the wrong
 * chat, an attachment taken by another pairing, a governed Project that fell
 * open when the engine was silent.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayClient } from "../../../packages/core/relay-client";
import type { MeshEvent, MeshSnapshot, SessionInfo, TaskCapsule } from "../../../packages/protocol/schema";
import { storeAttachment, takeAttachment } from "../../../apps/bridge/src/delivery/attachment-store";
import { consumeAttributedCall, recordAttributedCall } from "../../../apps/bridge/src/mesh/identity/call-scope";
import { checkpointBranchName } from "../../../apps/bridge/src/mesh/admin/checkpoint";
import { capsuleHash } from "../../../apps/bridge/src/mesh/handoff";
import { markRunsDelivered, recordRun, unreadRuns, type RunRecord } from "../../../apps/bridge/src/mesh/admin/journal";
import { MAX_CONTEXT_CHARS, promptContext } from "../../../apps/bridge/src/mesh/context/prompt";
import { createMeshRuntime, type MeshRuntimeDependencies } from "../../../apps/bridge/src/mesh/runtime";
import { MeshStore } from "../../../apps/bridge/src/mesh/store";
import { emptyStoreState, type StoreState } from "../../../apps/bridge/src/mesh/store/state";
import {
  applyStoreDelta, deltaIsEmpty, storeDelta, StoreLockError, withStoreLock,
} from "../../../apps/bridge/src/mesh/store/sync";
import { secretFilePath } from "../../../apps/bridge/src/sessions/support/edit-stats";
import {
  evaluateEffectiveAction,
  legacyGrantTapFlowAllowed,
} from "../../../apps/bridge/src/policy/effective-action";
import { governedRevision, rememberGovernedProject } from "../../../apps/bridge/src/policy/governed-projects";
import type { EngineClientLike } from "../../../apps/bridge/src/engine/runtime/engine-supervisor";
import { now, client, project, task, event, claim, isolatedConfig, capsule, handoff, run } from "../../support/mesh/mesh-audit-hardening-fixtures";

test("a claim is released only by its owner, from inside its own Task and Project", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-release-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject(project());
  store.upsertTask(task());
  store.upsertTask(task("task-2"));
  assert.equal(store.acceptEvent(event("claim", "RESOURCE_CLAIM", { claim: claim() })), true);
  const held = () => store.snapshot("project")?.claims.map((item) => item.claimId) ?? [];

  // A claim id is not a secret. Another chat that learned it changes nothing.
  assert.equal(store.acceptEvent(event("stranger", "RESOURCE_RELEASE", { claimId: "claim" }, { sourceSessionId: "codex" })), true);
  assert.deepEqual(held(), ["claim"]);
  // The owner, but speaking from another Task: still nothing.
  assert.equal(store.acceptEvent(event("elsewhere", "RESOURCE_RELEASE", { claimId: "claim" }, { sessionId: "task-2", taskId: "task-2" })), true);
  assert.deepEqual(held(), ["claim"]);
  // The owner, in the claim's own Task and Project.
  assert.equal(store.acceptEvent(event("owner", "RESOURCE_RELEASE", { claimId: "claim" })), true);
  assert.deepEqual(held(), []);
});

test("an agent's handoff request is recorded, never started; the phone's is taken up", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-handoff-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject(project());
  store.upsertTask(task("task", { ownerSessionId: "claude-source" }));
  store.linkExecution({
    taskId: "task", sessionId: "checkout", provider: "claude", computerId: "Workstation",
    workspace: "/repo", branch: "main", worktree: "/repo", startedAt: now,
  });
  const sent: Array<MeshEvent | MeshSnapshot> = [];
  let started = 0;
  const deps: MeshRuntimeDependencies = {
    store: () => store,
    sessions: () => [] as SessionInfo[],
    computer: () => "Workstation",
    now: () => now,
    eventId: (() => { let id = 0; return () => `response-${++id}`; })(),
    providerEnabled: () => true,
    start: async () => { started += 1; return { ok: true, text: "Started", sessionId: "codex-target" }; },
    deliver: async () => ({ ok: true, text: "" }),
    send: async (_client, payload) => { sent.push(payload); },
    worktree: () => ({ path: "/repo-worktree", branch: "granttap/codex/task" }),
    hasCommit: () => true,
    push: () => ({ ok: true, remote: "origin" }),
    fetch: () => false,
  };
  const runtime = createMeshRuntime(deps);

  assert.equal(await runtime.handle(client, handoff("agent-proposal"), "agent"), true);
  assert.equal(started, 0, "an agent's tool call starts no agent");
  assert.equal(sent.length, 0);
  assert.equal(store.snapshot("project")?.events.some((item) => item.eventId === "agent-proposal"), true, "the request itself is on record");

  assert.equal(await runtime.handle(client, handoff("phone-request")), true);
  assert.equal(started, 1, "the person's request, over the relay, is taken up");
  assert.equal((sent.at(-1) as MeshEvent).eventType, "HANDOFF_ACCEPTED");
});

test("two processes over one file keep each other's writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-sync-"));
  const path = join(root, "mesh.json");
  const monitor = new MeshStore(path, () => now);
  const server = new MeshStore(path, () => now);
  monitor.upsertProject(project());
  // The server loaded an empty file before the monitor wrote; its own save
  // used to replace the Project with nothing.
  server.upsertTask(task());
  assert.equal(server.project("project")?.name, "GrantTap");
  assert.equal(monitor.task("task")?.title, "Pairing");
  const disk = JSON.parse(await readFile(path, "utf8")) as StoreState;
  assert.equal(disk.projects.length, 1);
  assert.equal(disk.tasks.length, 1);

  // A removal made on one side is seen on the other.
  monitor.claim(claim());
  assert.equal(server.releaseClaim("claim", "claude"), true);
  assert.deepEqual(monitor.activeClaims(), []);
  // Both sides agree on a Task both edited.
  monitor.upsertTask(task("task", { title: "From the monitor", updatedAt: now + 10 }));
  server.upsertTask(task("task", { title: "From the server", updatedAt: now + 20 }));
  assert.equal(monitor.task("task")?.title, server.task("task")?.title);
  assert.equal((await readdir(root)).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")), false, "nothing left beside the file");
});

test("a change made here is laid over what another process wrote meanwhile", () => {
  const baseline: StoreState = { ...emptyStoreState(), tasks: [task("task", { revision: 1 })], claims: [claim("gone"), claim("kept")] };
  const current: StoreState = {
    ...baseline,
    tasks: [task("task", { revision: 2, title: "Ours" })],
    claims: [claim("kept"), claim("new")],
    projects: [project()],
  };
  const delta = storeDelta(baseline, current);
  assert.equal(deltaIsEmpty(delta), false);
  assert.equal(deltaIsEmpty(storeDelta(baseline, baseline)), true);
  assert.deepEqual(delta.claims.removed.map((removal) => removal.key), ["gone"]);
  assert.deepEqual(delta.claims.upserts.map((item) => (item.item as { claimId: string }).claimId), ["new"]);

  // Disk untouched for the Task: ours wins outright, whatever its revision says.
  const quiet = applyStoreDelta(baseline, delta);
  assert.equal(quiet.tasks[0]?.title, "Ours");
  assert.deepEqual(quiet.claims.map((item) => item.claimId), ["kept", "new"]);
  assert.equal(quiet.projects.length, 1);

  // Disk changed the same Task meanwhile: settled by revision, the same on both sides.
  const theirs: StoreState = { ...baseline, tasks: [task("task", { revision: 3, title: "Theirs" })] };
  assert.equal(applyStoreDelta(theirs, delta).tasks[0]?.title, "Theirs");
  const older: StoreState = { ...baseline, tasks: [task("task", { revision: 1, title: "Theirs, stale", updatedAt: now + 1 })] };
  assert.equal(applyStoreDelta(older, delta).tasks[0]?.title, "Ours");
});

test("a store file that cannot be read is set aside, never written over", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-corrupt-"));
  const path = join(root, "mesh.json");
  await writeFile(path, "{ not json");
  const store = new MeshStore(path, () => now);
  assert.deepEqual(store.projectIds(), []);
  assert.equal(await readFile(join(root, `mesh.json.unreadable-${now}`), "utf8"), "{ not json", "kept for a person to look at");
  store.upsertProject(project());
  assert.equal(new MeshStore(path, () => now).project("project")?.name, "GrantTap");

  // Garbage arriving under a running store is set aside too; memory is kept.
  await writeFile(path, "garbage");
  assert.equal(store.project("project")?.name, "GrantTap");
  store.upsertTask(task());
  const written = JSON.parse(await readFile(path, "utf8")) as StoreState;
  assert.equal(written.projects.length, 1);
  assert.equal(written.tasks.length, 1);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith("mesh.json.unreadable-")).sort(),
    [`mesh.json.unreadable-${now}`, `mesh.json.unreadable-${now}-2`],
    "the second one set aside in the same moment does not replace the first",
  );
});

test("a rejoined chat carries its events and dependencies to the surviving Task", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-rejoin-"));
  const path = join(root, "mesh.json");
  const scoped = (taskId: string) => ({ ...claim("c-new"), taskId });
  await writeFile(path, JSON.stringify({
    version: 1,
    projects: [project()],
    bindings: [],
    tasks: [
      task("task-old", { ownerSessionId: "chat", createdAt: now, updatedAt: now }),
      task("task-new", { ownerSessionId: "chat", createdAt: now + 5_000, updatedAt: now + 5_000 }),
      task("task-x", { ownerSessionId: "other-chat", createdAt: now, updatedAt: now }),
    ],
    executions: [
      { taskId: "task-old", sessionId: "chat", provider: "claude", computerId: "Mac.lan", workspace: "/repo", startedAt: now },
      { taskId: "task-new", sessionId: "chat", provider: "claude", computerId: "Serhiis-MacBook-Pro.local", workspace: "/repo", startedAt: now + 5_000 },
    ],
    claims: [scoped("task-new")],
    dependencies: [
      { taskId: "task-new", dependsOnTaskId: "task-old", createdAt: now },
      { taskId: "task-new", dependsOnTaskId: "task-x", createdAt: now },
    ],
    events: [
      event("e-claim", "RESOURCE_CLAIM", { claim: scoped("task-new") }, { sessionId: "task-new", taskId: "task-new" }),
      event("e-dep", "DEPENDENCY", { dependsOnTaskId: "task-x" }, { sessionId: "task-new", taskId: "task-new" }),
      event("e-handoff", "HANDOFF_REQUEST", { capsule: capsule({ taskId: "task-new", dependencies: ["task-old", "task-x"] }) }, { sessionId: "task-new", taskId: "task-new" }),
    ],
    receipts: [],
  }));
  const store = new MeshStore(path, () => now);
  // Before, the snapshot's own schema refused a rewritten event, and the Project stopped being published.
  const snapshot = store.snapshot("project");
  assert.ok(snapshot);
  assert.deepEqual(snapshot.tasks.map((item) => item.taskId).sort(), ["task-old", "task-x"]);
  assert.equal(snapshot.events.length, 3);
  for (const item of snapshot.events) {
    assert.equal(item.taskId, "task-old");
    assert.equal(item.sessionId, "task-old");
  }
  assert.equal(snapshot.events[0]?.payload.claim?.taskId, "task-old");
  assert.equal(snapshot.events[2]?.payload.capsule?.taskId, "task-old");
  assert.deepEqual(snapshot.events[2]?.payload.capsule?.dependencies, ["task-x"], "a Task does not depend on what it became");
  assert.deepEqual(snapshot.claims.map((item) => item.taskId), ["task-old"]);
  assert.deepEqual(
    snapshot.dependencies.map((item) => `${item.taskId}→${item.dependsOnTaskId}`),
    ["task-old→task-x"],
  );
});

test("the prompt context never marks a run read that it did not show", async (t) => {
  const marked: number[][] = [];
  const runs = Array.from({ length: 9 }, (_, index) => run(now + index * 1_000, "z".repeat(600)));
  const text = promptContext("chat", now + 60_000, {
    unread: () => runs,
    markDelivered: (_sessionId, _at, shown) => { marked.push(shown); },
    scope: () => undefined,
  })!;
  assert.ok(text.length <= MAX_CONTEXT_CHARS);
  assert.match(text, /^GrantTap: 9 messages/);
  assert.match(text, /\(\+\d earlier; they follow on your next turn\)/);
  assert.doesNotMatch(text, /…$/, "bounded by showing less, not by cutting");
  assert.equal(marked.length, 1);
  const shown = marked[0]!;
  assert.ok(shown.length > 0 && shown.length < 9);
  assert.deepEqual(shown, runs.slice(-shown.length).map((item) => item.at), "the newest runs were the ones shown");

  // The journal marks exactly those, so the rest come on the next turn.
  await isolatedConfig(t);
  for (const record of runs.slice(0, 3)) recordRun("chat", record);
  markRunsDelivered("chat", now + 60_000, [runs[1]!.at]);
  assert.deepEqual(unreadRuns("chat").map((item) => item.at), [runs[0]!.at, runs[2]!.at]);
  markRunsDelivered("chat", now + 61_000);
  assert.deepEqual(unreadRuns("chat"), []);
});

test("a tool call is attributed to the server's own chat, and never to another's alone", async (t) => {
  await isolatedConfig(t);
  const args = { message: "same words" };
  const record = (sessionId: string) => recordAttributedCall({
    provider: "claude", sessionId, toolName: "mcp__granttap__notify", args, now,
  });
  record("chat-one");
  record("chat-two");
  // Two chats made the same call at once: each server takes its own record.
  assert.equal(consumeAttributedCall("notify", args, now, "chat-one")?.sessionId, "chat-one");
  assert.equal(consumeAttributedCall("notify", args, now, "chat-two")?.sessionId, "chat-two");
  assert.equal(consumeAttributedCall("notify", args, now, "chat-two"), undefined, "taken once");
  // A record from another chat is never ours, and is left for that chat.
  record("chat-one");
  assert.equal(consumeAttributedCall("notify", args, now, "chat-three"), undefined);
  assert.equal(consumeAttributedCall("notify", args, now)?.sessionId, "chat-one");
});

test("an attachment is taken only by the pairing that sent it", async (t) => {
  await isolatedConfig(t);
  const upload = {
    type: "user.attachment" as const, attachmentId: "att-room", name: "photo.png", mimeType: "image/png",
    data: Buffer.from("png").toString("base64"), createdAt: now,
  };
  assert.equal(storeAttachment(upload, "room-a", now), true);
  assert.equal(takeAttachment("att-room", "room-b", now), undefined, "another pairing's message cannot name it");
  assert.equal(takeAttachment("att-room", "room-a", now)?.name, "photo.png", "left in place for its own message");
  assert.equal(storeAttachment({ ...upload, attachmentId: "att-legacy" }, undefined, now), true);
  assert.equal(takeAttachment("att-legacy", "room-a", now)?.name, "photo.png", "one stored without a room is anyone's");
});

test("a governed Project asks the person when the engine is silent, instead of falling open", async (t) => {
  await isolatedConfig(t);
  const flags = { GRANTTAP_ENGINE_ENABLED: "1", GRANTTAP_PROJECT_POLICY_ENABLED: "1" };
  const silent: EngineClientLike = { request: async () => { throw new Error("offline"); }, close: () => undefined };
  const evaluate = (engine: EngineClientLike) => evaluateEffectiveAction(
    { provider: "claude", toolName: "Write" },
    { env: flags, projectId: "governed", client: engine, now: () => now },
  );

  // Never seen governed: the legacy fallback, as before.
  const unknown = await evaluate(silent);
  assert.equal(unknown.effect, "inherit");
  assert.equal(unknown.engineEvaluated, false);

  // The engine's own answer teaches the hook that the Project has a policy.
  const answering: EngineClientLike = {
    request: async () => ({
      operation: "policy.evaluated",
      decision: { effect: "allow", source: "project", reason: "Project allows writes", policy_revision: 7 },
    }),
    close: () => undefined,
  };
  assert.equal((await evaluate(answering)).effect, "allow");
  assert.equal(governedRevision("governed"), 7);

  const held = await evaluate(silent);
  assert.equal(held.effect, "ask");
  assert.equal(held.source, "project");
  assert.equal(held.engineEvaluated, false);
  assert.equal(held.projectId, "governed");
  assert.match(held.reason, /revision 7/);
  assert.equal(legacyGrantTapFlowAllowed(held), false, "bypass and auto-accept stay closed");

  // An engine that answers something else is as silent as one that does not.
  const strange: EngineClientLike = { request: async () => ({ operation: "policy.found" } as never), close: () => undefined };
  assert.equal((await evaluate(strange)).effect, "ask");

  // A policy removed (revision 0) is forgotten, and the fallback is legacy again.
  rememberGovernedProject("governed", 0, now);
  assert.equal(governedRevision("governed"), undefined);
  assert.equal((await evaluate(silent)).effect, "inherit");
});

test("a checkpoint branch is named for its moment, under the Task's name", () => {
  const at = Date.UTC(2026, 8, 6, 10, 15, 0);
  assert.equal(checkpointBranchName("task/1", at), "granttap/checkpoint/task-1-20260906T101500-000");
  assert.notEqual(checkpointBranchName("task-1", at), checkpointBranchName("task-1", at + 1_000));
  assert.notEqual(checkpointBranchName("task-1", at), checkpointBranchName("task-1", at + 1), "the moment, to the millisecond");
  assert.equal(checkpointBranchName("task-1"), "granttap/checkpoint/task-1");
});

// ---------------------------------------------------------------------------
// The second pass: what the first fixes left open.
// ---------------------------------------------------------------------------

test("the store lock is held by a living process, waited for, and never entered without", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-lock-"));
  const path = join(root, "mesh.json");
  const lock = `${path}.lock`;
  // Another running process holds the lock: the wait runs out and the
  // critical section does not run. This process stands in for it.
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner"), `${process.pid}:someone-else`);
  let ran = 0;
  assert.throws(() => withStoreLock(path, () => { ran += 1; }, { waitMs: 80 }), StoreLockError);
  assert.equal(ran, 0, "no lock, no write");
  assert.equal(await readFile(join(lock, "owner"), "utf8"), `${process.pid}:someone-else`, "the holder's lock is left alone");
  // A lock whose owner is gone is taken over at once.
  await writeFile(join(lock, "owner"), "999999999:gone");
  assert.equal(withStoreLock(path, () => "written", { waitMs: 80 }), "written");
  assert.equal(existsSync(lock), false, "released by the process that took it");
  // An owner that finishes late never removes a lock taken over meanwhile.
  withStoreLock(path, () => {
    writeFileSync(join(lock, "owner"), "4242:taken-over");
  }, { waitMs: 80 });
  assert.equal(existsSync(lock), true, "not ours any more, so not removed");
  await rm(lock, { recursive: true, force: true });

  // A store whose write the lock held back keeps the change and writes it later.
  const store = new MeshStore(path, () => now);
  store.upsertProject(project());
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner"), `${process.pid}:busy`);
  const held = new MeshStore(path, () => now, { lockWaitMs: 60 });
  held.upsertTask(task());
  assert.equal(held.hasUnsavedChanges, true, "kept in memory, not written over a held lock");
  assert.equal(JSON.parse(await readFile(path, "utf8")).tasks.length, 0);
  await rm(lock, { recursive: true, force: true });
  assert.equal(held.flush(), true);
  assert.equal(held.hasUnsavedChanges, false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).tasks.length, 1);
  assert.equal(new MeshStore(path, () => now).task("task")?.title, "Pairing");
});
