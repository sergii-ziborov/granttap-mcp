import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MeshStore } from "../apps/bridge/src/mesh/store";

const at = 1_800_000_000_000;

test("one chat runs on one computer: a Mac renamed by its network does not become a second one", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-identity-"));
  let clock = at;
  const store = new MeshStore(join(root, "mesh.json"), () => clock);
  store.upsertProject({ projectId: "project", name: "gopherforge", repositoryRoot: "/repo", canonicalRepositoryId: "github.com/x/gopherforge", createdAt: at });
  store.upsertTask({ taskId: "task", projectId: "project", title: "давай опубликуем", goal: "goal", state: "planned", ownerSessionId: "chat", createdAt: at, updatedAt: at });
  const link = (computerId: string) => store.linkExecution({
    taskId: "task", sessionId: "chat", provider: "claude", computerId, workspace: "/repo", startedAt: at,
  });
  link("Serhiis-MacBook-Pro.local");
  clock += 60_000;
  link("Mac.lan");
  const open = () => store.snapshot("project")!.executions.filter((item) => item.endedAt == null).map((item) => item.computerId);
  assert.deepEqual(open(), ["Mac.lan"], "the name seen now lives; the old name is over");
  assert.equal(store.snapshot("project")!.executions.find((item) => item.computerId === "Serhiis-MacBook-Pro.local")?.endedAt, clock);

  // The stale twin can come back from a snapshot the phone still holds. A
  // closed execution stays closed on merge, and an unchanged scan of the live
  // one keeps it that way without rewriting the live row.
  const remote = store.snapshot("project")!;
  clock += 60_000;
  store.mergeSnapshot({
    ...remote,
    executions: remote.executions.map((item) =>
      item.computerId === "Serhiis-MacBook-Pro.local" ? { ...item, endedAt: undefined, updatedAt: clock } : item),
    generatedAt: clock,
  });
  assert.deepEqual(open(), ["Mac.lan"], "a closed execution stays closed");
  clock += 60_000;
  link("Mac.lan");
  assert.deepEqual(open(), ["Mac.lan"]);

  // Two different chats on two computers are two computers, untouched.
  store.upsertTask({ taskId: "task-2", projectId: "project", title: "another", goal: "goal", state: "planned", ownerSessionId: "chat-2", createdAt: at, updatedAt: at });
  store.linkExecution({ taskId: "task-2", sessionId: "chat-2", provider: "claude", computerId: "Serhiis-MacBook-Pro.local", workspace: "/repo", startedAt: at });
  assert.deepEqual(open().sort(), ["Mac.lan", "Serhiis-MacBook-Pro.local"]);
});
