import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_WINDOW_MS, meshBrief, meshMap } from "../../apps/bridge/src/mesh/snapshot/map";
import type { MeshSnapshot } from "../../packages/protocol/schema";

const now = Date.UTC(2026, 8, 21, 8, 0, 0);
const own = "github.com/example/api.git";
const worker = "github.com/example/worker";

function snapshot(overrides: Partial<MeshSnapshot> = {}): MeshSnapshot {
  return {
    type: "mesh.snapshot",
    sessionId: "project",
    projectId: "project",
    project: {
      projectId: "project", name: "Mesh", repositoryRoot: "/repo/api",
      canonicalRepositoryId: own, createdAt: now - 10_000,
    },
    bindings: [
      { bindingId: "api", projectId: "project", endpointId: "mac", repositoryId: own,
        displayName: "api", available: true },
      { bindingId: "worker", projectId: "project", endpointId: "mac", repositoryId: worker,
        displayName: "worker", available: true },
    ],
    tasks: [], executions: [], claims: [], dependencies: [], events: [], generatedAt: now,
    ...overrides,
  } as MeshSnapshot;
}

function task(id: string, updatedAt = now): MeshSnapshot["tasks"][number] {
  return {
    taskId: id, projectId: "project", title: id === "long" ? "x".repeat(120) : id,
    goal: id, state: "working", createdAt: now - 20_000, updatedAt,
  };
}

function execution(
  id: string, repositoryId: string | undefined, activeAt: number | undefined,
  extra: Partial<MeshSnapshot["executions"][number]> = {},
): MeshSnapshot["executions"][number] {
  return {
    taskId: id, sessionId: `session-${id}`, provider: "codex", computerId: "mac",
    workspace: repositoryId === own ? "/repo/api" : `/repo/${id}`,
    repositoryId, startedAt: now - 3 * LIVE_WINDOW_MS, activeAt, ...extra,
  };
}

function event(
  id: string, taskId: string, eventType: string, payload: Record<string, unknown>, createdAt = now,
): MeshSnapshot["events"][number] {
  return {
    type: "mesh.event", sessionId: taskId, eventId: id, projectId: "project", taskId,
    sourceSessionId: "source", eventType, createdAt, expiresAt: now + 60_000, payload,
  } as MeshSnapshot["events"][number];
}

test("the Mesh map renders bounded live, idle, event, claim, dependency, and backbone variants", () => {
  const tasks = ["self", "one", "two", "three", "four", "five", "six", "idle", "long"]
    .map((id, index) => task(id, now - index));
  const executions = [
    execution("self", own, now),
    execution("one", worker, now - 20_000),
    execution("two", undefined, now - 60_000),
    execution("three", worker, now - 59 * 60_000),
    execution("four", worker, undefined, { updatedAt: now - 30_000 }),
    execution("five", worker, undefined, { startedAt: now - 10_000 }),
    execution("six", worker, now + 60_000),
    execution("idle", worker, now - 3 * LIVE_WINDOW_MS),
    execution("long", worker, now - 49 * 60 * 60_000),
    execution("ended", worker, now, { endedAt: now - 1 }),
  ];
  const events = [
    event("summary", "one", "TASK_PROGRESS", { summary: "progress\nnext" }, now - 4),
    event("question", "two", "AGENT_QUESTION", { question: "question?" }, now - 3),
    event("answer", "three", "AGENT_ANSWER", { answer: "answer" }, now - 2),
    event("reason", "four", "TASK_BLOCKED", { reason: "reason" }, now - 1),
    event("empty", "five", "TASK_PROGRESS", {}, now),
  ];
  const value = snapshot({
    incomplete: true, tasks, executions, events,
    claims: [
      { claimId: "top", projectId: "project", taskId: "one", ownerSessionId: "session-one",
        resource: "README.md", mode: "intent", createdAt: now, expiresAt: now + 1_000 },
      { claimId: "repo", projectId: "project", taskId: "missing", ownerSessionId: "missing",
        repositoryId: worker, resource: "src/file.ts", mode: "claim", createdAt: now,
        expiresAt: now + 1_000 },
    ],
    dependencies: [
      { taskId: "one", dependsOnTaskId: "missing", createdAt: now },
    ],
    backbone: {
      projectId: "project",
      nodes: [{ kind: "repository", identity: own, displayName: "API" }],
      relations: [{ source: own, target: worker, relation: "calls_api", evidenceCount: 2 }],
      pendingCandidateCount: 0,
    },
  });
  const text = meshMap(value, now);
  assert.match(text, /9 Tasks · 7 active in the last hour · 2 idle · snapshot incomplete/);
  assert.match(text, /active just now/);
  assert.match(text, /active 1 min ago/);
  assert.match(text, /active 59 min ago/);
  assert.match(text, /idle since 3 h ago/);
  assert.match(text, /idle since 2 d ago/);
  assert.match(text, /task progress: progress next/);
  assert.match(text, /agent question: question\?/);
  assert.match(text, /agent answer: answer/);
  assert.match(text, /task blocked: reason/);
  assert.match(text, /`\(top level\)`/);
  assert.match(text, /worker \/ src/);
  assert.match(text, /one waits for missing/);
  assert.match(text, /API calls api → github\.com\/example\/worker \(2 verified evidence\)/);
  assert.ok(text.length < 10_000);
});

test("repository topology chooses Weavatrix, legacy, and empty fallbacks honestly", () => {
  const graph = {
    projectId: "project", repositoryId: "git@example.com:repo.git", revision: "abc",
    weavatrixVersion: "2.17.0", nodes: [], relations: [], totalNodes: 12,
    totalRelations: 8, truncated: true,
  };
  assert.match(meshMap(snapshot({ repositoryGraphs: [graph] }), now),
    /repo — Weavatrix 2\.17\.0 · 12 nodes · 8 relations · bounded view/);
  assert.match(meshMap(snapshot({ repositoryGraphs: [{ ...graph, truncated: false }] }), now),
    /12 nodes · 8 relations\n/);
  assert.match(meshMap(snapshot({ peers: [{
    projectId: "project", repositoryId: own, peer: "worker", via: "api",
    relation: "called_by", updatedAt: now,
  }] }), now), /api called by → worker \(api, legacy\)/);
  assert.match(meshMap(snapshot({ peers: [{
    projectId: "project", repositoryId: own, peer: "worker", via: "kafka",
    relation: "produces", through: "events", updatedAt: now,
  }] }), now), /produces events → worker/);
  assert.match(meshMap(snapshot(), now), /Engine topology has not been observed yet/);
});

test("the Task brief covers active overflow, idle grammar, neighbours, questions, policy, and environment", () => {
  const tasks = ["self", "one", "two", "three", "four", "five", "six", "idle"]
    .map((id) => task(id));
  const value = snapshot({
    tasks,
    executions: [
      execution("self", own, now), execution("one", worker, now),
      execution("two", undefined, now - 2 * 60_000), execution("three", worker, now),
      execution("four", worker, now), execution("five", worker, now), execution("six", worker, now),
      execution("idle", worker, now - 2 * LIVE_WINDOW_MS),
    ],
    claims: [
      { claimId: "self-file", projectId: "project", taskId: "self", ownerSessionId: "self",
        repositoryId: own, endpointId: "mac", resource: "src/a.ts", mode: "claim",
        createdAt: now, expiresAt: now + 1 },
      { claimId: "same-file", projectId: "project", taskId: "one", ownerSessionId: "one",
        repositoryId: own, resource: "src/a.ts", mode: "claim", createdAt: now, expiresAt: now + 1 },
      { claimId: "logical", projectId: "project", taskId: "two", ownerSessionId: "two",
        repositoryId: own, endpointId: "other", resource: "src/a.ts", mode: "claim",
        createdAt: now, expiresAt: now + 1 },
      { claimId: "module", projectId: "project", taskId: "three", ownerSessionId: "three",
        repositoryId: own, resource: "src/b.ts", mode: "claim", createdAt: now, expiresAt: now + 1 },
    ],
    events: [
      event("q-open", "self", "AGENT_QUESTION", { question: "Still open?" }),
      event("q-done", "self", "AGENT_QUESTION", { question: "Already done?" }),
      event("a-done", "self", "AGENT_ANSWER", { questionEventId: "q-done", answer: "yes" }),
    ],
    peers: [{ projectId: "project", repositoryId: own, peer: "worker", via: "api",
      relation: "calls", updatedAt: now }],
    restrictions: { projectId: "project", revision: 1, scope: "project_and_repo", source: "phone", rules: [
      { ruleId: "one", kind: "max_file_lines", limit: 300, effect: "deny" },
      { ruleId: "two", kind: "max_function_lines", limit: 100, effect: "deny" },
    ] },
    environment: { projectId: "project", revision: 1, shareNonSecretsWithRepo: false, variables: [
      { key: "REGION", value: "west", secret: false }, { key: "TOKEN", secret: true },
    ] },
  });
  const lines = meshBrief(value, "self", now);
  assert.match(lines[0] ?? "", /\(\+1\).*1 other chat here is open but idle/);
  assert.ok(lines.some((line) => line.includes("editing the same checkout file")));
  assert.ok(lines.some((line) => line.includes("editing that path in another checkout")));
  assert.ok(lines.some((line) => line.includes("working in the same module")));
  assert.ok(lines.some((line) => line.startsWith("Other side:")));
  assert.ok(lines.some((line) => line === "Still unanswered: Still open?"));
  assert.ok(lines.some((line) => line === "Project restrictions: 2 rules on the Project and the repository."));
  assert.ok(lines.some((line) => line === "Project environment: REGION, TOKEN (secret)."));

  const oneIdle = snapshot({ tasks: [task("self"), task("idle")], executions: [
    execution("self", own, now), execution("idle", worker, now - 2 * LIVE_WINDOW_MS),
  ], restrictions: { projectId: "project", revision: 1, scope: "sync_from_repo", source: "repo", rules: [
    { ruleId: "one", kind: "max_file_lines", limit: 300, effect: "deny" },
  ] } });
  assert.ok(meshBrief(oneIdle, "self", now).includes(
    "1 other chat in this Project is open but idle for over an hour."));
  assert.ok(meshBrief(oneIdle, "self", now).includes(
    "Project restrictions: 1 rule synced from the repository."));
  oneIdle.restrictions = { ...oneIdle.restrictions!, scope: "project" };
  assert.ok(meshBrief(oneIdle, "self", now).includes("Project restrictions: 1 rule on this Project."));
  assert.deepEqual(meshBrief(snapshot(), "missing", now), []);
});
