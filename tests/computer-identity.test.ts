import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computerId, computerIdentity, formerComputerNames, resetComputerIdentity,
} from "../apps/bridge/src/mesh/computer-identity";
import { linkSessionsToProjects } from "../apps/bridge/src/mesh/catalog";
import { MeshStore } from "../apps/bridge/src/mesh/store";

const at = 1_800_000_000_000;

async function configDir(t: { after: (fn: () => void) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-computer-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetComputerIdentity();
  t.after(() => {
    resetComputerIdentity();
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  return root;
}

test("a computer keeps the identity it was first seen under, and remembers every later name", async (t) => {
  const root = await configDir(t);
  const home = computerIdentity({}, () => "Serhiis-MacBook-Pro.local", () => at);
  assert.equal(home.computerId, "Serhiis-MacBook-Pro.local");
  assert.deepEqual(home.names, ["Serhiis-MacBook-Pro.local"]);
  assert.equal(home.createdAt, at);
  const written = JSON.parse(await readFile(join(root, "computer.json"), "utf8")) as { computerId: string };
  assert.equal(written.computerId, "Serhiis-MacBook-Pro.local");

  // Renamed by the network: same computer, one more name.
  const road = computerIdentity({}, () => "Mac.lan", () => at + 1);
  assert.equal(road.computerId, "Serhiis-MacBook-Pro.local");
  assert.deepEqual(road.names, ["Serhiis-MacBook-Pro.local", "Mac.lan"]);
  assert.deepEqual(formerComputerNames({}), ["Mac.lan"], "the road name is a former name of the same machine");

  // Read back from disk by a fresh process, the identity is the same.
  resetComputerIdentity();
  assert.equal(computerIdentity({}, () => "Mac.lan", () => at + 3).computerId, "Serhiis-MacBook-Pro.local");

  // An explicit id wins and writes nothing.
  assert.equal(computerId({ GRANTTAP_COMPUTER_ID: "studio" }), "studio");

  // A file that says nothing usable is replaced.
  await writeFile(join(root, "computer.json"), "{}");
  resetComputerIdentity();
  assert.equal(computerIdentity({}, () => "Mac.lan", () => at + 4).computerId, "Mac.lan");
  await writeFile(join(root, "computer.json"), "not json");
  resetComputerIdentity();
  assert.equal(computerIdentity({}, () => "Mac.lan", () => at + 5).computerId, "Mac.lan");
});

test("a directory that cannot be written still yields an identity for this process", async (t) => {
  await configDir(t);
  process.env.GRANTTAP_CONFIG_DIR = join(await mkdtemp(join(tmpdir(), "granttap-file-")), "not-a-dir.txt");
  await writeFile(process.env.GRANTTAP_CONFIG_DIR, "occupied");
  resetComputerIdentity();
  assert.equal(computerIdentity({}, () => "Mac.lan", () => at).computerId, "Mac.lan");
});

test("records under a former name are retired, not deleted, so the phone learns the same", async (t) => {
  const root = await configDir(t);
  const store = new MeshStore(join(root, "mesh.json"), () => at);
  store.upsertProject({ projectId: "project", name: "gopherforge", repositoryRoot: "/repo", canonicalRepositoryId: "github.com/x/gopherforge", createdAt: at });
  store.upsertTask({ taskId: "task", projectId: "project", title: "t", goal: "g", state: "planned", ownerSessionId: "chat", createdAt: at, updatedAt: at });
  store.linkExecution({ taskId: "task", sessionId: "chat", provider: "claude", computerId: "Mac.lan", workspace: "/repo", startedAt: at });
  store.upsertBinding({ bindingId: "b-old", projectId: "project", endpointId: "Mac.lan", repositoryId: "github.com/x/gopherforge", displayName: "gopherforge", available: true });
  store.upsertBinding({ bindingId: "b-new", projectId: "project", endpointId: "Serhiis-MacBook-Pro.local", repositoryId: "github.com/x/gopherforge", displayName: "gopherforge", available: true });

  store.retireComputerNames("Serhiis-MacBook-Pro.local", ["Mac.lan", "Serhiis-MacBook-Pro.local", ""]);
  const snapshot = store.snapshot("project")!;
  assert.equal(snapshot.executions.find((item) => item.computerId === "Mac.lan")?.endedAt, at);
  assert.equal(snapshot.bindings?.find((item) => item.endpointId === "Mac.lan")?.available, false);
  assert.equal(snapshot.bindings?.find((item) => item.endpointId === "Serhiis-MacBook-Pro.local")?.available, true);
  store.retireComputerNames("Serhiis-MacBook-Pro.local", []);
  store.retireComputerNames("Serhiis-MacBook-Pro.local", ["Mac.lan"]);

  // The catalog retires them on every pass, before linking what is live now.
  const linked = linkSessionsToProjects(store, [], "Serhiis-MacBook-Pro.local", undefined, ["Mac.lan"]);
  assert.deepEqual(linked, []);
});
