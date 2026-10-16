import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayClient } from "../../../../../../../packages/core/relay-client";
import type {
  ExecutionSessionLink, MeshEvent, MeshHandoffPrepare, MeshSnapshot, SessionInfo,
} from "../../../../../../../packages/protocol/schema";
import { MeshHandoffPrepare as PrepareSchema } from "../../../../../../../packages/protocol/schema";
import { createMeshRuntime, type MeshRuntimeDependencies } from "../..";
import { MeshStore } from "../../../store";
import { closeVanished } from "../../execution-sweep";
import type { CloudLaunchInput } from "../../../../cloud-runners";

const now = 1_800_000_000_000;
const client = {} as RelayClient;
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-cloud-handoff-"));
  execFileSync("git", ["init", "-q", "-b", "feature/pairing", root]);
  git(root, ["config", "user.email", "t@example.com"]); git(root, ["config", "user.name", "t"]);
  git(root, ["remote", "add", "origin", "https://github.com/example/granttap.git"]);
  await writeFile(join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]); git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

async function harness(overrides: Partial<MeshRuntimeDependencies> = {}) {
  const cwd = await checkout();
  const store = new MeshStore(join(await mkdtemp(join(tmpdir(), "granttap-cloud-mesh-")), "mesh.json"), () => now);
  const sent: Array<MeshEvent | MeshSnapshot> = [];
  const launches: CloudLaunchInput[] = [];
  const pushes: string[] = [];
  const sessions: SessionInfo[] = [{ sessionId: "chat", agent: "claude", title: "Pairing", cwd, branch: "feature/pairing",
    state: "idle", startedAt: now - 1_000, lastActivityAt: now, tokensSession: 1, tokensLastTurn: 1 }];
  const deps: MeshRuntimeDependencies = {
    store: () => store, sessions: () => sessions, computer: () => "MacBook", now: () => now,
    eventId: (() => { let id = 0; return () => `event-${++id}`; })(), providerEnabled: () => true,
    start: async () => ({ ok: false, error: "no local start for a cloud run" }),
    deliver: async () => ({ ok: true, text: "" }), send: async (_client, payload) => { sent.push(payload); },
    worktree: () => undefined, hasCommit: () => true, fetch: () => false,
    push: (_cwd, branch) => { pushes.push(branch ?? ""); return { ok: true, remote: "origin" }; },
    remoteHasCommit: () => false,
    launchCloud: async (input) => { launches.push(input);
      return { ok: true, reference: "cse_01", url: "https://claude.ai/code/cse_01" }; },
    ...overrides,
  };
  const runtime = createMeshRuntime(deps);
  const linked = runtime.catalog(sessions)[0]!;
  const request = (extra: Partial<MeshHandoffPrepare> = {}): MeshHandoffPrepare => PrepareSchema.parse({
    type: "mesh.handoff.prepare", sessionId: "chat", projectId: linked.projectId, taskId: linked.taskId,
    targetProvider: "claude", targetComputer: "MacBook", targetModel: "opus", createdAt: now,
    prepareOnly: true, cloud: {}, ...extra,
  });
  return { runtime, store, sent, launches, pushes, linked, request, cwd };
}

const blocked = (sent: Array<MeshEvent | MeshSnapshot>) =>
  sent.filter((item): item is MeshEvent => item.type === "mesh.event" && item.eventType === "TASK_BLOCKED")
    .map(item => item.payload.reason);

test("a Task goes to Claude cloud through its own computer and comes back as an external execution with a link", async () => {
  const run = await harness();
  assert.equal(await run.runtime.prepare(client, run.request({ push: true })), true);
  assert.deepEqual(run.pushes, ["feature/pairing"], "the cloud runner fetches the pushed branch");
  assert.equal(run.launches.length, 1);
  assert.equal(run.launches[0]!.provider, "claude");
  assert.equal(run.launches[0]!.model, "opus");
  assert.equal(realpathSync(run.launches[0]!.cwd), realpathSync(run.cwd), "launched in the Task's own checkout");
  assert.equal(run.launches[0]!.capsule.branch, "feature/pairing");
  const execution = run.store.snapshot(run.linked.projectId!)?.executions.find(item => item.sessionId === "cse_01");
  assert.deepEqual(execution?.external, { runner: "claude_cloud", url: "https://claude.ai/code/cse_01" });
  assert.equal(execution?.computerId, "MacBook");
  assert.equal(execution?.provider, "claude");
  assert.equal(run.store.snapshot(run.linked.projectId!)?.tasks[0]?.ownerSessionId, "chat",
    "the open local chat keeps the Task; the cloud run is observed only through its link");
  const progress = run.sent.find((item): item is MeshEvent => item.type === "mesh.event" && item.eventType === "TASK_PROGRESS");
  assert.match(progress?.payload.summary ?? "", /Claude cloud .*MacBook.*https:\/\/claude\.ai\/code\/cse_01/);
  assert.ok(run.sent.some(item => item.type === "mesh.snapshot"
    && item.executions.some(row => row.external?.runner === "claude_cloud")), "the phone sees it without waiting a cycle");
  assert.deepEqual(blocked(run.sent), []);
});

test("a cloud run that could not fetch the work, or was asked of another computer, never starts", async () => {
  const unpushed = await harness();
  assert.equal(await unpushed.runtime.prepare(client, unpushed.request()), false);
  assert.match(blocked(unpushed.sent)[0] ?? "", /push/i);
  assert.equal(unpushed.launches.length, 0);

  const pushed = await harness({ remoteHasCommit: () => true });
  assert.equal(await pushed.runtime.prepare(client, pushed.request()), true, "an already pushed branch needs no push");
  assert.deepEqual(pushed.pushes, []);

  const elsewhere = await harness();
  assert.equal(await elsewhere.runtime.prepare(client, elsewhere.request({ targetComputer: "Studio", push: true })), false);
  assert.match(blocked(elsewhere.sent)[0] ?? "", /computer that holds this Task/);
  assert.equal(elsewhere.launches.length, 0);

  const refused = await harness({ push: () => ({ ok: false, error: "Push of feature/pairing to origin failed: denied" }) });
  assert.equal(await refused.runtime.prepare(client, refused.request({ push: true })), false);
  assert.match(blocked(refused.sent)[0] ?? "", /denied/);
});

test("a provider that could not start the cloud run says so, and nothing pretends it is running", async () => {
  const run = await harness({ remoteHasCommit: () => true,
    launchCloud: async () => ({ ok: false, error: "Claude cloud did not start: Error: Unable to create cloud session" }) });
  assert.equal(await run.runtime.prepare(client, run.request()), false);
  assert.deepEqual(blocked(run.sent), ["Claude cloud did not start: Error: Unable to create cloud session"]);
  assert.equal(run.store.snapshot(run.linked.projectId!)?.executions.some(item => item.external), false);
});

test("Codex Cloud receives the named environment and no local model", async () => {
  const run = await harness({ remoteHasCommit: () => true });
  assert.equal(await run.runtime.prepare(client, run.request({ targetProvider: "codex", targetModel: undefined,
    cloud: { environment: "example/granttap" } })), true);
  assert.equal(run.launches[0]!.provider, "codex");
  assert.equal(run.launches[0]!.environment, "example/granttap");
  assert.throws(() => PrepareSchema.parse({ ...run.request(), targetProvider: "cursor" }), "only Claude and Codex have cloud runners");
});

test("an external execution is not swept as a vanished local chat", () => {
  const executions: ExecutionSessionLink[] = [
    { taskId: "t", sessionId: "cse_01", provider: "claude", computerId: "MacBook", workspace: "/repo",
      startedAt: now, external: { runner: "claude_cloud" } },
    { taskId: "t", sessionId: "gone", provider: "claude", computerId: "MacBook", workspace: "/repo", startedAt: now },
  ];
  assert.equal(closeVanished(executions, { computerId: "MacBook", liveSessionIds: new Set(),
    scannedProviders: new Set(["claude"]), endedAt: now + 1 }), 1);
  assert.equal(executions[0]!.endedAt, undefined);
  assert.equal(executions[1]!.endedAt, now + 1);
});
