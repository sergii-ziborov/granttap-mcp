import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayClient } from "../../packages/core/relay-client";
import type {
  MeshEvent,
  MeshProvider,
  MeshSnapshot,
  SessionInfo,
  TaskCapsule,
} from "../../packages/protocol/schema";
import {
  createMeshRuntime,
  handleMeshPayload,
  meshCatalog,
  meshSnapshots,
  prepareMeshHandoff,
  type MeshRuntimeDependencies,
} from "../../apps/bridge/src/mesh/runtime";
import {
  localMeshStore,
  meshStorePath,
  resetLocalMeshStore,
} from "../../apps/bridge/src/mesh/local-remote/local";
import { MeshStore } from "../../apps/bridge/src/mesh/store";

const now = 1_800_000_000_000;
const client = {} as RelayClient;

async function gitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-runtime-repo-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "README.md"), "base\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test",
    "commit", "-q", "-m", "base"]);
  return root;
}

function session(cwd: string): SessionInfo {
  return {
    sessionId: "claude-source", agent: "claude", title: "Pairing refactor",
    summary: "Crypto complete", cwd, branch: "claude/pairing", state: "working",
    startedAt: now - 1_000, lastActivityAt: now, tokensSession: 10, tokensLastTurn: 2,
  };
}

function capsule(overrides: Partial<TaskCapsule> = {}): TaskCapsule {
  return {
    taskId: "task", goal: "Finish pairing", currentStatus: "Crypto complete",
    sourceProvider: "claude", sourceComputer: "MacBook", targetProvider: "codex",
    targetComputer: "Workstation", repository: "github.com/example/granttap",
    baseSha: "a".repeat(40), latestCommit: "b".repeat(40), filesChanged: ["src/auth/login.ts"],
    testsStatus: "Unit tests pass", dependencies: [], resourceClaims: [],
    remainingWork: ["Run regression tests"], importantDecisions: ["Use connectionId"],
    createdAt: now, ...overrides,
  };
}

function handoff(id: string, value = capsule()): MeshEvent {
  return {
    type: "mesh.event", sessionId: value.taskId, eventId: id, projectId: "project",
    taskId: value.taskId, sourceSessionId: "claude-source", eventType: "HANDOFF_REQUEST",
    createdAt: now, expiresAt: now + 60_000, payload: { capsule: value },
  };
}

async function harness(overrides: Partial<MeshRuntimeDependencies> = {}) {
  const state = await mkdtemp(join(tmpdir(), "granttap-mesh-runtime-state-"));
  const store = new MeshStore(join(state, "mesh.json"), () => now);
  const sent: Array<MeshEvent | MeshSnapshot> = [];
  const sessions: SessionInfo[] = [];
  const deps: MeshRuntimeDependencies = {
    store: () => store,
    sessions: () => sessions,
    computer: () => "Workstation",
    now: () => now,
    eventId: (() => { let id = 0; return () => `response-${++id}`; })(),
    providerEnabled: () => true,
    start: async () => ({ ok: true, text: "Started", sessionId: "codex-target" }),
    deliver: async () => ({ ok: true, text: "Use connectionId" }),
    send: async (_client, payload) => { sent.push(payload); },
    worktree: () => ({ path: "/repo-worktree", branch: "granttap/codex/task" }),
    hasCommit: () => true,
    push: () => ({ ok: true, remote: "origin" }),
    fetch: () => false,
    ...overrides,
  };
  return { runtime: createMeshRuntime(deps), store, sent, sessions };
}

function seedLocalCheckout(store: MeshStore): void {
  store.upsertProject({
    projectId: "project", name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  });
  store.upsertTask({
    taskId: "task", projectId: "project", title: "Pairing", goal: "Finish pairing",
    state: "working", ownerSessionId: "claude-source", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: "task", sessionId: "checkout", provider: "claude", computerId: "Workstation",
    workspace: "/repo", branch: "main", worktree: "/repo", startedAt: now,
  });
}

test("runtime accepts a handoff into a separate worktree and signs a receipt", async () => {
  let prompt = "";
  const run = await harness({
    start: async (provider: MeshProvider, value: string, cwd: string) => {
      assert.equal(provider, "codex");
      assert.equal(cwd, "/repo-worktree");
      prompt = value;
      return { ok: true, text: "Started", sessionId: "codex-target" };
    },
  });
  seedLocalCheckout(run.store);
  assert.equal(await run.runtime.handle(client, handoff("handoff-success")), true);
  assert.match(prompt, /Important decisions:\n- Use connectionId/);
  assert.match(prompt, /Remaining work:\n- Run regression tests/);
  assert.doesNotMatch(prompt, /hidden reasoning:|transcript:/i);
  const accepted = run.sent.at(-1) as MeshEvent;
  assert.equal(accepted.eventType, "HANDOFF_ACCEPTED");
  assert.equal(accepted.payload.receipt?.targetSessionId, "codex-target");
  assert.equal(run.store.snapshot("project")?.tasks[0]?.ownerSessionId, "codex-target");
  assert.equal(await run.runtime.handle(client, handoff("handoff-success")), true);
  assert.equal(run.sent.length, 1);
});

test("handoff failures are bounded, explicit, and routed to human attention", async () => {
  const missing = await harness();
  await missing.runtime.handle(client, handoff("missing-checkout"));
  assert.match((missing.sent[0] as MeshEvent).payload.reason ?? "", /authorized local checkout/);

  const conflict = await harness();
  seedLocalCheckout(conflict.store);
  conflict.store.claim({
    claimId: "claim", projectId: "project", taskId: "task", ownerSessionId: "codex-other",
    resource: "src/auth/**", mode: "claim", createdAt: now, expiresAt: now + 60_000,
  });
  await conflict.runtime.handle(client, handoff("conflict"));
  assert.match((conflict.sent[0] as MeshEvent).payload.reason ?? "", /currently claims/);

  const disabled = await harness({ providerEnabled: () => false });
  seedLocalCheckout(disabled.store);
  await disabled.runtime.handle(client, handoff("disabled-provider"));
  assert.match((disabled.sent[0] as MeshEvent).payload.reason ?? "", /disabled in GrantTap Settings/);

  for (const [id, overrides, expected] of [
    ["no-worktree", { worktree: () => null }, /worktree could not be created/],
    ["start-error", { start: async () => ({ ok: false as const, error: "agent failed" }) }, /agent failed/],
    ["no-session", { start: async () => ({ ok: true as const, text: "started" }) }, /did not create a session/],
  ] as const) {
    const failed = await harness(overrides);
    seedLocalCheckout(failed.store);
    await failed.runtime.handle(client, handoff(id));
    const event = failed.sent[0] as MeshEvent;
    assert.equal(event.eventType, "HANDOFF_REJECTED");
    assert.equal(event.payload.needsUser, true);
    assert.match(event.payload.reason ?? "", expected);
  }
});

/** The chat a question may name: a live execution of the Project on this computer. */
function seedQuestionTarget(store: MeshStore, projectId = "project", taskId = "task"): void {
  store.upsertProject({
    projectId, name: `Project ${projectId}`, repositoryRoot: `/repo/${projectId}`,
    canonicalRepositoryId: `github.com/example/${projectId}`, createdAt: now,
  });
  store.upsertTask({
    taskId, projectId, title: "Pairing", goal: "Finish pairing",
    state: "working", ownerSessionId: "claude-source", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId, sessionId: "claude-source", provider: "claude", computerId: "Workstation",
    workspace: `/repo/${projectId}`, branch: "main", startedAt: now,
  });
}

test("agent questions stay agent-to-agent and publish only a bounded answer", async () => {
  const run = await harness();
  run.sessions.push(session("/repo"));
  seedQuestionTarget(run.store);
  const question = (id: string, payload: MeshEvent["payload"], targetSessionId?: string): MeshEvent => ({
    type: "mesh.event", sessionId: "task", eventId: id, projectId: "project", taskId: "task",
    sourceSessionId: "codex-source", targetSessionId, eventType: "AGENT_QUESTION",
    createdAt: now, expiresAt: now + 60_000, payload,
  });
  await run.runtime.handle(client, question("no-question", {}, "claude-source"));
  await run.runtime.handle(client, question("no-target", { question: "Name?" }));
  await run.runtime.handle(client, question("missing-target", { question: "Name?" }, "missing"));
  assert.equal(run.sent.length, 0);
  await run.runtime.handle(client, question("answer", { question: "Field name?" }, "claude-source"));
  const answer = run.sent[0] as MeshEvent;
  assert.equal(answer.eventType, "AGENT_ANSWER");
  assert.equal(answer.targetSessionId, "codex-source");
  assert.equal(answer.payload.answer, "Use connectionId");

  // Another Project that merely learned this chat's session id gets no answer
  // from it: the question stays inside the Project the chat belongs to.
  run.store.upsertProject({
    projectId: "other", name: "Other", repositoryRoot: "/repo/other",
    canonicalRepositoryId: "github.com/example/other", createdAt: now,
  });
  run.store.upsertTask({
    taskId: "other-task", projectId: "other", title: "Other", goal: "Elsewhere",
    state: "working", ownerSessionId: "codex-source", createdAt: now, updatedAt: now,
  });
  await run.runtime.handle(client, {
    ...question("cross-project", { question: "What is in the pairing key?" }, "claude-source"),
    sessionId: "other-task", taskId: "other-task", projectId: "other",
  });
  assert.equal(run.sent.length, 1, "no answer crosses a Project boundary");

  const failed = await harness({ deliver: async () => ({ ok: false, error: "offline" }) });
  failed.sessions.push(session("/repo"));
  seedQuestionTarget(failed.store);
  await failed.runtime.handle(client, question("delivery-failed", { question: "Name?" }, "claude-source"));
  assert.equal(failed.sent.length, 0);
});

test("runtime snapshots merge and handoff preparation preserves the discovered task id", async () => {
  const repo = await gitRepository();
  const run = await harness();
  run.sessions.push(session(repo));
  const linked = run.runtime.catalog(run.sessions);
  const source = linked[0]!;
  assert.ok(source.projectId && source.taskId);
  assert.equal(run.runtime.snapshots().length, 1);
  const snapshot = run.runtime.snapshots()[0]!;
  const merged = await harness();
  assert.equal(await merged.runtime.handle(client, snapshot), true);
  assert.equal(merged.runtime.snapshots()[0]?.projectId, source.projectId);

  const request = {
    type: "mesh.handoff.prepare" as const, sessionId: source.sessionId,
    projectId: source.projectId!, taskId: source.taskId!, targetProvider: "codex" as const,
    targetComputer: "Workstation", createdAt: now,
  };
  assert.equal(await run.runtime.prepare(client, { ...request, taskId: "wrong" }), false);
  run.sessions[0] = source;
  assert.equal(await run.runtime.prepare(client, request), true);
  const event = run.sent[0] as MeshEvent;
  assert.equal(event.eventType, "HANDOFF_REQUEST");
  assert.equal(event.taskId, source.taskId);
  assert.equal(event.payload.capsule?.targetComputer, "Workstation");
  assert.match(run.runtime.capsulePrompt(event.payload.capsule!), /Latest commit:/);
});

test("handoffs for another computer and empty capsules are ignored", async () => {
  const run = await harness();
  seedLocalCheckout(run.store);
  await run.runtime.handle(client, handoff("other-computer", capsule({ targetComputer: "Other" })));
  const progress: MeshEvent = {
    ...handoff("progress"), eventType: "TASK_PROGRESS", payload: { summary: "Working" },
  };
  await run.runtime.handle(client, progress);
  assert.equal(run.sent.length, 0);
  assert.equal(hostname().length > 0, true);
});

test("published snapshots stay inside the phone snapshot allowlist", async () => {
  const repo = await gitRepository();
  const run = await harness();
  run.sessions.push(session(repo));
  run.runtime.catalog(run.sessions);
  const snaps = run.runtime.snapshots();
  assert.ok(snaps.length > 0);
  const allowed = new Set([
    "type", "sessionId", "projectId", "publisherEndpointId", "project", "tasks", "executions",
    "bindings", "peers", "skills", "incomplete", "execution", "restrictions",
    "environment", "modelCatalog", "mcpServers", "capabilityRequests",
    "capabilityObservations", "backbone", "repositoryGraphs", "cortex",
    "claims", "dependencies", "events", "knowledge", "generatedAt",
  ]);
  for (const snap of snaps) {
    for (const key of Object.keys(snap)) {
      assert.ok(allowed.has(key), `phone rejects unknown snapshot key ${key}`);
    }
    assert.ok(snap.modelCatalog, "monitor always attaches modelCatalog");
    assert.equal(snap.modelCatalog?.[0]?.reason === "not_reported"
      || (snap.modelCatalog?.[0]?.models.length ?? 0) > 0, true);
  }
});

test("default entry points share one protected local mesh store", async () => {
  const config = await mkdtemp(join(tmpdir(), "granttap-mesh-default-runtime-"));
  process.env.GRANTTAP_CONFIG_DIR = config;
  resetLocalMeshStore();
  assert.equal(meshStorePath(), join(config, "project-mesh.json"));
  assert.equal(localMeshStore(), localMeshStore());
  assert.deepEqual(meshCatalog([]), []);
  const snapshot: MeshSnapshot = {
    type: "mesh.snapshot", sessionId: "default-project", projectId: "default-project",
    project: {
      projectId: "default-project", name: "Default",
      canonicalRepositoryId: "github.com/example/default", createdAt: now,
    },
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: now,
  };
  assert.equal(await handleMeshPayload(client, snapshot), true);
  assert.equal(meshSnapshots()[0]?.projectId, "default-project");
  assert.equal(await prepareMeshHandoff(client, {
    type: "mesh.handoff.prepare", sessionId: "missing", projectId: "missing",
    taskId: "missing", targetProvider: "codex", targetComputer: "Workstation", createdAt: now,
  }), false);
  resetLocalMeshStore();
  delete process.env.GRANTTAP_CONFIG_DIR;
});

test("a handoff to another agent on the same computer is taken up at once", async () => {
  const repo = await gitRepository();
  let startedIn = "";
  const run = await harness({
    start: async (_provider: MeshProvider, _prompt: string, cwd: string) => {
      startedIn = cwd;
      return { ok: true, text: "Started", sessionId: "codex-local" };
    },
  });
  run.sessions.push(session(repo));
  const source = run.runtime.catalog(run.sessions)[0]!;
  run.sessions[0] = source;
  assert.equal(await run.runtime.prepare(client, {
    type: "mesh.handoff.prepare", sessionId: source.sessionId, projectId: source.projectId!,
    taskId: source.taskId!, targetProvider: "codex", targetComputer: "Workstation", createdAt: now,
    push: true,
  }), true);
  const types = run.sent.map((item) => (item as MeshEvent).eventType);
  assert.deepEqual(types, ["HANDOFF_REQUEST", "HANDOFF_ACCEPTED"], "no push for the same computer");
  assert.equal(startedIn, "/repo-worktree");
  assert.equal(run.store.snapshot(source.projectId!)?.tasks[0]?.ownerSessionId, "codex-local");
});

test("a push the person asked for happens before the capsule leaves, and blocks the move when it fails", async () => {
  const repo = await gitRepository();
  const pushes: string[] = [];
  const run = await harness({
    push: (_cwd, branch) => { pushes.push(branch ?? "?"); return { ok: true, remote: "origin" }; },
  });
  run.sessions.push(session(repo));
  const source = run.runtime.catalog(run.sessions)[0]!;
  run.sessions[0] = source;
  const request = {
    type: "mesh.handoff.prepare" as const, sessionId: source.sessionId, projectId: source.projectId!,
    taskId: source.taskId!, targetProvider: "codex" as const, targetComputer: "Air", createdAt: now,
  };
  assert.equal(await run.runtime.prepare(client, { ...request, push: true }), true);
  assert.deepEqual(pushes, ["claude/pairing"]);
  assert.equal((run.sent.at(-1) as MeshEvent).eventType, "HANDOFF_REQUEST");

  const failing = await harness({ push: () => ({ ok: false, error: "Push of x to origin failed: rejected" }) });
  failing.sessions.push(session(repo));
  failing.sessions[0] = failing.runtime.catalog(failing.sessions)[0]!;
  assert.equal(await failing.runtime.prepare(client, { ...request, sessionId: failing.sessions[0]!.sessionId, push: true }), false);
  const blocked = failing.sent.at(-1) as MeshEvent;
  assert.equal(blocked.eventType, "TASK_BLOCKED");
  assert.match(blocked.payload.reason ?? "", /rejected/);
});

test("a destination without the commit fetches it before refusing", async () => {
  const fetched: string[] = [];
  const run = await harness({
    hasCommit: () => false,
    fetch: (_repository, revision, branch) => { fetched.push(`${revision.slice(0, 4)}@${branch ?? "-"}`); return true; },
  });
  seedLocalCheckout(run.store);
  await run.runtime.handle(client, handoff("fetched", capsule({ branch: "granttap/checkpoint/task" })));
  assert.deepEqual(fetched, ["bbbb@granttap/checkpoint/task"]);
  assert.equal((run.sent.at(-1) as MeshEvent).eventType, "HANDOFF_ACCEPTED");

  const stillMissing = await harness({ hasCommit: () => false, fetch: () => false });
  seedLocalCheckout(stillMissing.store);
  await stillMissing.runtime.handle(client, handoff("unfetched"));
  assert.match((stillMissing.sent.at(-1) as MeshEvent).payload.reason ?? "", /not on this computer/);
});
