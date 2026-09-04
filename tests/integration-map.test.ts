import assert from "node:assert/strict";
import test from "node:test";
import { parseIntegrationMap } from "../apps/bridge/src/mesh/integration-map";

// The README example of weavatrix-md, verbatim: the only format the map has.
const example = `# Weavatrix

Repository: \`payments-api\`

## Database

- PostgreSQL / \`payments\`
  - \`payment-worker\`

## Kafka

- \`payment.completed\`
  - produces → \`payment-worker\`

## API

- called by ← \`checkout-web\`
`;

test("the other side of each database, topic, and API is read as the map states it", () => {
  assert.deepEqual(parseIntegrationMap(example), [
    { peer: "payment-worker", via: "database", relation: "shares", through: "PostgreSQL / payments" },
    { peer: "payment-worker", via: "kafka", relation: "produces", through: "payment.completed" },
    { peer: "checkout-web", via: "api", relation: "called_by" },
  ]);
});

test("nothing outside the three sections, and nothing the map does not say, becomes an edge", () => {
  assert.deepEqual(parseIntegrationMap("# Weavatrix\n\n## Owners\n\n- alice\n"), []);
  assert.deepEqual(parseIntegrationMap("## Kafka\n\n- \`orders\`\n  - something else\n"), []);
  assert.deepEqual(parseIntegrationMap(""), []);
  // A repeated statement is one edge.
  const twice = "## API\n\n- calls → \`billing\`\n- calls → \`billing\`\n";
  assert.equal(parseIntegrationMap(twice).length, 1);
});

import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshStore } from "../apps/bridge/src/mesh/store";
import { clearIntegrationMapCache, readIntegrationMap } from "../apps/bridge/src/mesh/integration-map";
import { otherSide, otherSides, repositoryNames } from "../apps/bridge/src/mesh/other-side";
import { scopedNeighbours } from "../apps/bridge/src/mesh/scoped-view";
import type { MeshSnapshot } from "../packages/protocol/schema";

const at = 1_800_000_000_000;
const projectId = "project-pay";
const api = "github.com/example/payments-api";
const worker = "github.com/example/payment-worker";

function binding(repositoryId: string, displayName: string, endpointId = "mac-a") {
  return {
    bindingId: `binding-${displayName}-${endpointId}`, projectId, endpointId, repositoryId, displayName, available: true,
  };
}

function seeded(root: string, now: () => number): MeshStore {
  const store = new MeshStore(join(root, "mesh.json"), now);
  store.upsertProject({
    projectId, name: "Payments", repositoryRoot: "/repo/payments-api", canonicalRepositoryId: api, createdAt: at,
  });
  store.upsertBinding(binding(api, "payments-api"));
  store.upsertBinding(binding(worker, "payment-worker"));
  for (const [taskId, sessionId, repositoryId] of [["task-api", "claude-api", api], ["task-worker", "codex-worker", worker]] as const) {
    store.upsertTask({
      taskId, projectId, title: `${taskId} title`, goal: `${taskId} goal`, state: "working",
      ownerSessionId: sessionId, createdAt: at, updatedAt: at,
    });
    store.linkExecution({
      taskId, sessionId, provider: sessionId.startsWith("claude") ? "claude" : "codex", computerId: "mac-a",
      workspace: `/repo/${repositoryId.split("/").pop()}`, repositoryId, startedAt: at,
    });
  }
  return store;
}

test("a repository's statement is published once, replaced when it changes, and kept across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-peers-"));
  let clock = at;
  const store = seeded(root, () => clock);
  assert.equal(store.snapshot(projectId)?.peers, undefined, "no map, no peers key");

  store.recordIntegrationPeers(projectId, api, parseIntegrationMap(example));
  const first = store.snapshot(projectId)?.peers;
  assert.equal(first?.length, 3);
  assert.equal(first?.[1]?.peer, "payment-worker");

  clock += 1_000;
  store.recordIntegrationPeers(projectId, api, parseIntegrationMap(example));
  assert.deepEqual(store.snapshot(projectId)?.peers, first, "an unchanged statement is not rewritten");

  clock += 1_000;
  store.recordIntegrationPeers(projectId, api, [{ peer: "checkout-web", via: "api", relation: "called_by" }]);
  assert.equal(store.snapshot(projectId)?.peers?.length, 1, "edges the map dropped are dropped here");
  // An unknown Project records nothing.
  store.recordIntegrationPeers("project-unknown", api, [{ peer: "x", via: "api", relation: "calls" }]);

  const reopened = new MeshStore(join(root, "mesh.json"), () => clock);
  assert.equal(reopened.snapshot(projectId)?.peers?.length, 1);
});

test("peers another computer publishes are merged like its bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-peers-merge-"));
  const store = seeded(root, () => at);
  store.recordIntegrationPeers(projectId, api, [{ peer: "payment-worker", via: "kafka", relation: "produces", through: "payment.completed" }]);
  const remote = store.snapshot(projectId)!;
  store.mergeSnapshot({
    ...remote,
    peers: [
      ...(remote.peers ?? []),
      { projectId, repositoryId: worker, peer: "payments-api", via: "kafka", relation: "consumes", through: "payment.completed", updatedAt: at },
    ],
    generatedAt: at + 1,
  });
  assert.deepEqual(store.snapshot(projectId)?.peers?.map((peer) => `${peer.repositoryId}:${peer.relation}`), [
    `${api}:produces`, `${worker}:consumes`,
  ]);
});

test("the other side of a Task's repository is found from either side's statement", async () => {
  // Shared with the phone's vector test: change one, change both.
  const root = await mkdtemp(join(tmpdir(), "granttap-other-side-"));
  const store = seeded(root, () => at);
  store.recordIntegrationPeers(projectId, api, [{ peer: "Payment-Worker", via: "kafka", relation: "produces", through: "payment.completed" }]);
  const snapshot = store.snapshot(projectId)!;

  assert.deepEqual([...repositoryNames(binding(worker, "Worker checkout"))].sort(), ["payment-worker", "worker checkout"]);
  assert.deepEqual(otherSides(api, snapshot).map((edge) => edge.repositoryId), [worker], "stated by this side");
  assert.deepEqual(otherSides(worker, snapshot).map((edge) => edge.repositoryId), [api], "stated by the other side");

  const fromApi = otherSide(snapshot, "task-api");
  assert.equal(fromApi.length, 1);
  assert.equal(fromApi[0]?.taskId, "task-worker");
  assert.equal(fromApi[0]?.through, "payment.completed");
  assert.equal(fromApi[0]?.statedBy, api);
  assert.equal(otherSide(snapshot, "task-worker")[0]?.taskId, "task-api", "the worker sees the api Task too");

  // An execution that ended is not on the other side of anything.
  const ended: MeshSnapshot = {
    ...snapshot,
    executions: snapshot.executions.map((execution) =>
      execution.taskId === "task-worker" ? { ...execution, endedAt: at + 1 } : execution),
  };
  assert.deepEqual(otherSide(ended, "task-api"), []);

  // Without a repository id, the Project root still places an execution.
  const byRoot: MeshSnapshot = {
    ...snapshot,
    executions: snapshot.executions.map((execution) =>
      execution.taskId === "task-api" ? { ...execution, repositoryId: undefined, workspace: "/repo/payments-api/apps" } : execution),
  };
  assert.equal(otherSide(byRoot, "task-api")[0]?.taskId, "task-worker");
  assert.equal(otherSide({ ...byRoot, project: { ...byRoot.project, repositoryRoot: undefined } }, "task-api").length, 0);
});

test("an agent's scoped view names the claims next to its own by file and by module", () => {
  const claim = (taskId: string, resource: string) => ({
    claimId: `${taskId}-${resource}`, projectId, taskId, ownerSessionId: taskId, resource,
    mode: "intent" as const, createdAt: at, expiresAt: at + 60_000,
  });
  const claims = [
    claim("task-api", "apps/bridge/src/mesh/store.ts"),
    claim("task-worker", "apps/bridge/src/mesh/store.ts"),
    claim("task-worker", "apps/bridge/src/mesh/catalog.ts"),
    claim("task-worker", "README.md"),
  ];
  assert.deepEqual(scopedNeighbours({ claims }, "task-api").map((item) => [item.claim.resource, item.kind]), [
    ["apps/bridge/src/mesh/store.ts", "file"],
    ["apps/bridge/src/mesh/catalog.ts", "module"],
  ]);
  assert.deepEqual(scopedNeighbours({ claims }, "task-worker").map((item) => item.kind), ["file"]);
});

test("the map is read from the repository root and re-read only when it changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-map-"));
  clearIntegrationMapCache();
  assert.deepEqual(readIntegrationMap(root), []);
  await writeFile(join(root, "WEAVATRIX.md"), example);
  assert.equal(readIntegrationMap(root).length, 3);
  await writeFile(join(root, "WEAVATRIX.md"), "## API\n\n- calls → `billing`\n");
  const later = new Date(Date.now() + 5_000);
  await utimes(join(root, "WEAVATRIX.md"), later, later);
  assert.deepEqual(readIntegrationMap(root).map((edge) => edge.peer), ["billing"]);
  assert.deepEqual(readIntegrationMap(root).map((edge) => edge.peer), ["billing"], "served from the cache");
  await writeFile(join(root, "WEAVATRIX.md"), "x".repeat(300 * 1_024));
  assert.deepEqual(readIntegrationMap(root), [], "an oversized map is ignored");
});
