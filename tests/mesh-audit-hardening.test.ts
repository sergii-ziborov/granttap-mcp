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
import type { RelayClient } from "../packages/core/relay-client";
import type { MeshEvent, MeshSnapshot, SessionInfo, TaskCapsule } from "../packages/protocol/schema";
import { storeAttachment, takeAttachment } from "../apps/bridge/src/attachment-store";
import { consumeAttributedCall, recordAttributedCall } from "../apps/bridge/src/mesh/call-scope";
import { checkpointBranchName } from "../apps/bridge/src/mesh/checkpoint";
import { capsuleHash } from "../apps/bridge/src/mesh/handoff";
import { markRunsDelivered, recordRun, unreadRuns, type RunRecord } from "../apps/bridge/src/mesh/journal";
import { MAX_CONTEXT_CHARS, promptContext } from "../apps/bridge/src/mesh/prompt-context";
import { createMeshRuntime, type MeshRuntimeDependencies } from "../apps/bridge/src/mesh/runtime";
import { MeshStore } from "../apps/bridge/src/mesh/store";
import { emptyStoreState, type StoreState } from "../apps/bridge/src/mesh/store-state";
import {
  applyStoreDelta, deltaIsEmpty, storeDelta, StoreLockError, withStoreLock,
} from "../apps/bridge/src/mesh/store-sync";
import { secretFilePath } from "../apps/bridge/src/sessions/edit-stats";
import {
  evaluateEffectiveAction,
  legacyGrantTapFlowAllowed,
} from "../apps/bridge/src/policy/effective-action";
import { governedRevision, rememberGovernedProject } from "../apps/bridge/src/policy/governed-projects";
import type { EngineClientLike } from "../apps/bridge/src/engine/engine-supervisor";

const now = 1_800_000_000_000;
const client = {} as RelayClient;

function project(projectId = "project") {
  return {
    projectId, name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  };
}

function task(taskId = "task", overrides: Record<string, unknown> = {}) {
  return {
    taskId, projectId: "project", title: "Pairing", goal: "Finish pairing",
    state: "working" as const, ownerSessionId: "claude", createdAt: now, updatedAt: now, ...overrides,
  };
}

function event(
  id: string,
  eventType: MeshEvent["eventType"],
  payload: MeshEvent["payload"],
  overrides: Partial<MeshEvent> = {},
): MeshEvent {
  return {
    type: "mesh.event", sessionId: "task", eventId: id, projectId: "project", taskId: "task",
    sourceSessionId: "claude", eventType, createdAt: now + id.length, expiresAt: now + 60_000,
    payload, ...overrides,
  };
}

function claim(claimId = "claim") {
  return {
    claimId, projectId: "project", taskId: "task", ownerSessionId: "claude",
    resource: "src/auth/**", mode: "claim" as const, createdAt: now, expiresAt: now + 60_000,
  };
}

async function isolatedConfig(t: { after: (fn: () => void) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  return root;
}

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

function capsule(overrides: Partial<TaskCapsule> = {}): TaskCapsule {
  return {
    taskId: "task", goal: "Finish pairing", currentStatus: "Crypto complete",
    sourceProvider: "claude", sourceComputer: "MacBook", targetProvider: "codex",
    targetComputer: "Workstation", repository: "github.com/example/granttap",
    baseSha: "a".repeat(40), latestCommit: "b".repeat(40), filesChanged: ["src/auth/login.ts"],
    dependencies: [], resourceClaims: [], remainingWork: [], importantDecisions: [],
    createdAt: now, ...overrides,
  };
}

function handoff(id: string): MeshEvent {
  return event(id, "HANDOFF_REQUEST", { capsule: capsule() }, { sourceSessionId: "claude-source" });
}

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

function run(at: number, outcome = "Done."): RunRecord {
  return { at, endedAt: at + 1_000, source: "phone", prompt: `Message at ${at}`, ok: true, outcome, files: [], tools: 1 };
}

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

test("a removal made here is applied only to the row as it was read", () => {
  // Process A read a claim about to expire and decided to drop it; process B
  // renewed the same claim meanwhile. A's removal must not take B's renewal.
  const stale = claim("lease");
  const baseline: StoreState = { ...emptyStoreState(), claims: [{ ...stale, expiresAt: 100 }] };
  const current: StoreState = { ...baseline, claims: [] };
  const delta = storeDelta(baseline, current);
  assert.equal(delta.claims.removed.length, 1);
  const renewedOnDisk: StoreState = { ...baseline, claims: [{ ...stale, expiresAt: 1_000 }] };
  assert.deepEqual(applyStoreDelta(renewedOnDisk, delta).claims.map((item) => item.expiresAt), [1_000], "the renewed lease survives");
  const unchangedOnDisk: StoreState = { ...baseline, claims: [{ ...stale, expiresAt: 100 }] };
  assert.deepEqual(applyStoreDelta(unchangedOnDisk, delta).claims, [], "the lease as read is removed");
});

test("a change not yet written is laid over what another process wrote, when the store looks again", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-dirty-"));
  const path = join(root, "mesh.json");
  const lock = `${path}.lock`;
  const first = new MeshStore(path, () => now);
  first.upsertProject(project());
  const second = new MeshStore(path, () => now, { lockWaitMs: 60 });
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner"), `${process.pid}:busy`);
  // Two chats, two Tasks; the same owner would make them one chat rejoined on load.
  second.upsertTask(task("mine", { ownerSessionId: "chat-mine" }));
  assert.equal(second.hasUnsavedChanges, true);
  await rm(lock, { recursive: true, force: true });
  // Someone else writes meanwhile; the next look merges rather than discards.
  first.upsertTask(task("theirs", { ownerSessionId: "chat-theirs" }));
  assert.deepEqual(second.snapshot("project")?.tasks.map((item) => item.taskId).sort(), ["mine", "theirs"]);
  assert.equal(second.flush(), true);
  assert.deepEqual(new MeshStore(path, () => now).snapshot("project")?.tasks.map((item) => item.taskId).sort(), ["mine", "theirs"]);
});

test("a receipt written before a Task was rejoined still names its capsule", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-receipt-"));
  const path = join(root, "mesh.json");
  const requested = capsule({ taskId: "task-new" });
  const oldHash = capsuleHash(requested);
  const request = event("req", "HANDOFF_REQUEST", { capsule: requested }, {
    sessionId: "task-new", taskId: "task-new", sourceSessionId: "chat",
  });
  await writeFile(path, JSON.stringify({
    version: 1,
    projects: [project()],
    bindings: [],
    tasks: [
      task("task-old", { ownerSessionId: "chat", createdAt: now, updatedAt: now }),
      task("task-new", { ownerSessionId: "chat", createdAt: now + 5_000, updatedAt: now + 5_000 }),
    ],
    executions: [
      { taskId: "task-old", sessionId: "chat", provider: "claude", computerId: "Mac.lan", workspace: "/repo", startedAt: now },
      { taskId: "task-new", sessionId: "chat", provider: "claude", computerId: "Serhiis-MacBook-Pro.local", workspace: "/repo", startedAt: now + 5_000 },
    ],
    claims: [], dependencies: [], events: [request],
    receipts: [{ sourceSessionId: "chat", targetSessionId: "codex-target", taskId: "task-new", capsuleHash: oldHash, acceptedAt: now + 6_000 }],
  }));
  const store = new MeshStore(path, () => now);
  const snapshot = store.snapshot("project")!;
  const rewritten = snapshot.events[0]!.payload.capsule!;
  assert.equal(rewritten.taskId, "task-old");
  const newHash = capsuleHash(rewritten);
  assert.notEqual(newHash, oldHash, "a capsule is named by its content, and its Task id is content");
  const disk = JSON.parse(await readFile(path, "utf8")) as StoreState;
  // Not yet on disk until something is written; the store's own view carries the move.
  assert.ok(disk);
  store.upsertProject({ ...project(), name: "Renamed" });
  const written = JSON.parse(await readFile(path, "utf8")) as StoreState;
  assert.deepEqual(written.receipts.map((item) => item.capsuleHash), [newHash], "the receipt names the capsule as it is now");
  assert.deepEqual(written.migrations.map((item) => [item.taskIdFrom, item.taskIdTo, item.capsuleHashFrom, item.capsuleHashTo]),
    [["task-new", "task-old", oldHash, newHash]], "and the move itself is on record");
  // An acceptance still on its way, naming the old hash, is accepted for the rejoined Task.
  const accepted = event("acc", "HANDOFF_ACCEPTED", {
    receipt: { sourceSessionId: "chat", targetSessionId: "codex-late", taskId: "task-old", capsuleHash: oldHash, acceptedAt: now + 7_000 },
  }, { sessionId: "task-old", taskId: "task-old", sourceSessionId: "codex-late" });
  assert.equal(store.acceptEvent(accepted), true);
  const forged = event("forged", "HANDOFF_ACCEPTED", {
    receipt: { sourceSessionId: "chat", targetSessionId: "codex-x", taskId: "task-old", capsuleHash: "f".repeat(64), acceptedAt: now + 8_000 },
  }, { sessionId: "task-old", taskId: "task-old", sourceSessionId: "codex-x" });
  assert.equal(store.acceptEvent(forged), false, "an unknown hash is still no receipt");
});

test("one long run is said briefly rather than cut, and the map is always in reach", () => {
  const marked: number[][] = [];
  const files = Array.from({ length: 24 }, (_, index) => `apps/very/long/path/to/a/module/that/goes/on/and/on/file-number-${index}.swift`);
  const big: RunRecord = {
    at: now, endedAt: now + 1_000, source: "phone", prompt: "p".repeat(200), ok: true,
    outcome: "o".repeat(600), files, tools: 40,
  };
  const scope = {
    snapshot: {
      type: "mesh.snapshot", sessionId: "project", projectId: "project", project: project(),
      tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: now,
    } as unknown as MeshSnapshot,
    taskId: "task",
  };
  const text = promptContext("chat", now + 60_000, {
    unread: () => [big],
    markDelivered: (_sessionId, _at, shown) => { marked.push(shown); },
    scope: () => scope,
  })!;
  assert.ok(text.length <= MAX_CONTEXT_CHARS);
  assert.doesNotMatch(text, /…$/, "never cut");
  assert.match(text, /^GrantTap: 1 message/);
  assert.match(text, /wrote (\d+ files \(see the transcript\)|apps\/very)/);
  assert.deepEqual(marked, [[now]], "shown in short, so told");
  // With a Mesh brief, its envelope survives even when the run is the size of the budget.
  const withBrief = promptContext("chat", now + 60_000, {
    unread: () => [big],
    markDelivered: () => {},
    scope: () => ({ ...scope, snapshot: { ...scope.snapshot, tasks: [
      { taskId: "other", projectId: "project", title: "Other work", goal: "Elsewhere", state: "working", ownerSessionId: "peer", createdAt: now, updatedAt: now + 59_000 },
    ], executions: [
      { taskId: "other", sessionId: "peer", provider: "codex", computerId: "Mac", workspace: "/repo", startedAt: now, updatedAt: now + 59_000 },
    ] } as unknown as MeshSnapshot }),
  })!;
  assert.ok(withBrief.length <= MAX_CONTEXT_CHARS);
  assert.match(withBrief, /Full map: read the granttap MCP resource granttap:\/\/mesh\/map$/, "the way to the map is never dropped");
});

test("a checkpoint excludes secrets by name, not code that sounds like one", () => {
  for (const path of [".env", ".env.local", "config/production.env", "deploy.pem", "certs/server.key", "id_rsa", "id_ed25519.pub",
    "credentials.json", "secrets.yaml", "app.secret", "service-account-prod.json", ".npmrc", "infra/terraform.tfstate"]) {
    assert.equal(secretFilePath(path), true, path);
  }
  for (const path of ["src/tokenizer.ts", "src/password-strength.ts", "lib/secret-santa.ts", "docs/credentials-policy.md",
    "auth/token.service.ts", "keyboard.swift", "monkey.ts", "env.d.ts", "environment.ts"]) {
    assert.equal(secretFilePath(path), false, path);
  }
  assert.equal(secretFilePath(undefined), false);
});

test("a checkpoint of a checkout shared with other work is marked for review", async () => {
  const repo = await mkdtemp(join(tmpdir(), "granttap-audit-shared-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git(["config", "user.email", "t@example.com"]); git(["config", "user.name", "t"]);
  await writeFile(join(repo, "README.md"), "base\n");
  git(["add", "README.md"]); git(["commit", "-q", "-m", "base"]);
  await writeFile(join(repo, "README.md"), "changed by somebody\n");

  const store = new MeshStore(join(await mkdtemp(join(tmpdir(), "granttap-audit-shared-store-")), "mesh.json"), () => now);
  const sent: Array<MeshEvent | MeshSnapshot> = [];
  const sessions: SessionInfo[] = [
    { sessionId: "claude-source", agent: "claude", title: "Pairing", cwd: repo, branch: "main", state: "working", startedAt: now, lastActivityAt: now, tokensSession: 1, tokensLastTurn: 1 },
    { sessionId: "codex-other", agent: "codex", title: "Billing", cwd: repo, branch: "main", state: "working", startedAt: now, lastActivityAt: now, tokensSession: 1, tokensLastTurn: 1 },
  ];
  const runtime = createMeshRuntime({
    store: () => store, sessions: () => sessions, computer: () => "MacBook", now: () => now,
    eventId: (() => { let id = 0; return () => `e-${++id}`; })(), providerEnabled: () => true,
    start: async () => ({ ok: true, text: "", sessionId: "x" }), deliver: async () => ({ ok: true, text: "" }),
    send: async (_client, payload) => { sent.push(payload); },
    worktree: () => ({ path: "/w", branch: "b" }), hasCommit: () => true,
    push: () => ({ ok: true, remote: "origin" }), fetch: () => false,
  });
  const linked = runtime.catalog(sessions);
  const source = linked.find((item) => item.sessionId === "claude-source")!;
  const other = linked.find((item) => item.sessionId === "codex-other")!;
  assert.notEqual(source.taskId, other.taskId, "two chats, two Tasks, one checkout");
  sessions.splice(0, sessions.length, source, other);
  const request = {
    type: "mesh.handoff.prepare" as const, sessionId: source.sessionId, projectId: source.projectId!,
    taskId: source.taskId!, targetProvider: "codex" as const, targetComputer: "Air", createdAt: now + 123, checkpoint: true,
  };
  assert.equal(await runtime.prepare(client, request), true);
  const capsule = (sent.at(-1) as MeshEvent).payload.capsule!;
  assert.equal(capsule.checkpoint?.status, "requires_review", "the commit may carry the other Task's changes");
  assert.match(capsule.branch ?? "", /-\d{8}T\d{6}-123$/, "named by the request's own moment");
  assert.match(runtime.capsulePrompt(capsule), /Checkpoint: needs review/);

  // Alone in the checkout, the same checkpoint is complete.
  sessions.splice(1, 1);
  await writeFile(join(repo, "README.md"), "changed again\n");
  assert.equal(await runtime.prepare(client, { ...request, createdAt: now + 456 }), true);
  const alone = (sent.at(-1) as MeshEvent).payload.capsule!;
  assert.equal(alone.checkpoint?.status, "complete");
  assert.match(runtime.capsulePrompt(alone), /Checkpoint: complete \(1 file\)/);
});

test("the runtime rejoins a split chat exactly as the shared fixture says the phone must", async () => {
  // The same fixture is embedded in the phone's tests, so both implementations
  // are held to one answer: which Task survives, where every name inside every
  // event ends up, and the hash the rewritten capsule gets.
  const fixture = JSON.parse(await readFile(new URL("./fixtures/split-chat.json", import.meta.url), "utf8")) as {
    input: MeshSnapshot & { receipts?: unknown[] };
    expected: {
      tasks: string[]; taskId: string; claimTaskIds: string[]; dependencies: string[];
      capsuleDependencies: string[]; originalCapsuleHash: string; capsuleHash: string;
    };
  };
  const { input, expected } = fixture;
  const accepted = input.events.find((item) => item.eventType === "HANDOFF_ACCEPTED")!;
  const request = input.events.find((item) => item.eventType === "HANDOFF_REQUEST")!;
  assert.equal(capsuleHash(request.payload.capsule!), expected.originalCapsuleHash, "the fixture's hash is this runtime's hash");
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-fixture-"));
  const path = join(root, "mesh.json");
  await writeFile(path, JSON.stringify({
    version: 1, projects: [input.project], bindings: [], tasks: input.tasks, executions: input.executions,
    claims: input.claims, dependencies: input.dependencies, events: input.events,
    receipts: [accepted.payload.receipt],
  }));
  const store = new MeshStore(path, () => now);
  const snapshot = store.snapshot("project")!;
  assert.deepEqual(snapshot.tasks.map((item) => item.taskId).sort(), expected.tasks);
  for (const event of snapshot.events) {
    assert.equal(event.taskId, expected.taskId, event.eventId);
    assert.equal(event.sessionId, expected.taskId, event.eventId);
  }
  assert.deepEqual(snapshot.claims.map((item) => item.taskId), expected.claimTaskIds);
  assert.deepEqual(snapshot.events.find((item) => item.eventType === "RESOURCE_CLAIM")?.payload.claim?.taskId, expected.taskId);
  assert.deepEqual(snapshot.dependencies.map((item) => `${item.taskId}->${item.dependsOnTaskId}`), expected.dependencies);
  const capsule = snapshot.events.find((item) => item.eventType === "HANDOFF_REQUEST")!.payload.capsule!;
  assert.equal(capsule.taskId, expected.taskId);
  assert.deepEqual(capsule.dependencies, expected.capsuleDependencies);
  assert.equal(capsuleHash(capsule), expected.capsuleHash);
  const receipt = snapshot.events.find((item) => item.eventType === "HANDOFF_ACCEPTED")!.payload.receipt!;
  assert.equal(receipt.capsuleHash, expected.capsuleHash, "the receipt names the capsule as it is now");
  assert.equal(receipt.taskId, expected.taskId);
});
