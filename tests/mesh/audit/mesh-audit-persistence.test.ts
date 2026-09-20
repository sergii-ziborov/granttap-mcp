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
  const fixture = JSON.parse(await readFile(new URL("../../fixtures/split-chat.json", import.meta.url), "utf8")) as {
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

test("a released claim does not come back with a snapshot that still has it", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-tombstone-"));
  const store = new MeshStore(join(root, "mesh.json"), () => now);
  store.upsertProject(project());
  store.upsertTask(task());
  store.claim(claim("held"));
  assert.equal(store.releaseClaim("held"), true);
  // A computer that was away publishes what it last knew, the claim included.
  const stale = store.snapshot("project")!;
  store.mergeSnapshot({ ...stale, claims: [claim("held")], generatedAt: now + 1 });
  assert.deepEqual(store.snapshot("project")?.claims, [], "released is released");
  assert.equal(store.acceptEvent(event("late-claim", "RESOURCE_CLAIM", { claim: claim("held") })), true);
  assert.deepEqual(store.snapshot("project")?.claims, [], "and a late claim event neither");
  assert.equal(store.observeClaim(claim("held")), false);
  // The release is on disk, so a fresh store keeps it too; a new claim is its own.
  const reopened = new MeshStore(join(root, "mesh.json"), () => now);
  reopened.mergeSnapshot({ ...stale, claims: [claim("held"), claim("fresh")], generatedAt: now + 2 });
  assert.deepEqual(reopened.snapshot("project")?.claims.map((item) => item.claimId), ["fresh"]);
  // Once the claim itself would have expired, the release is forgotten with it.
  const later = new MeshStore(join(root, "mesh.json"), () => now + 120_000);
  later.activeClaims();
  assert.equal(JSON.parse(await readFile(join(root, "mesh.json"), "utf8")).releasedClaims.length, 0);
});

test("a claim is checked and recorded as one step, and not at all when the lock is held", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-claim-"));
  const path = join(root, "mesh.json");
  const store = new MeshStore(path, () => now, { lockWaitMs: 60 });
  store.upsertProject(project());
  store.upsertTask(task());
  store.upsertTask(task("task-2", { ownerSessionId: "codex" }));
  const mine = claim("mine");
  const first = store.acceptClaimEvent(event("c1", "RESOURCE_CLAIM", { claim: mine }));
  assert.deepEqual(first, { applied: true, accepted: true });
  const theirs = { ...claim("theirs"), taskId: "task-2", ownerSessionId: "codex", resource: "src/auth/login.ts" };
  const second = store.acceptClaimEvent(event("c2", "RESOURCE_CLAIM", { claim: theirs }, { sessionId: "task-2", taskId: "task-2", sourceSessionId: "codex" }));
  assert.equal(second.applied && second.accepted, false);
  assert.equal(second.applied ? second.conflict?.claimId : undefined, "mine", "the conflict is the state it would have been written into");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).claims.map((item: { claimId: string }) => item.claimId), ["mine"], "on disk before anyone is told");
  // The lock held by a living process: nothing is recorded, and the caller is told so.
  const lock = `${path}.lock`;
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner"), `${process.pid}:busy`);
  const held = store.acceptClaimEvent(event("c3", "RESOURCE_CLAIM", { claim: claim("later") }));
  assert.deepEqual(held, { applied: false });
  await rm(lock, { recursive: true, force: true });
  assert.equal(store.snapshot("project")?.claims.some((item) => item.claimId === "later"), false);
  assert.equal(store.acceptClaimEvent(event("c3", "RESOURCE_CLAIM", { claim: claim("later") })).applied, true);
  assert.equal(store.acceptClaimEvent(event("nope", "TASK_PROGRESS", { summary: "x" })).applied && false, false);
});
