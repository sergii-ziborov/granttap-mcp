import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { MeshRepositoryList, MeshRepositoryQuery } from "../../../../../../packages/protocol/schema";
import { MeshRepositoryList as ListSchema } from "../../../../../../packages/protocol/schema";
import { inspectRepository } from "../../catalog";
import { handleMeshRepositoryRequest } from "..";
import { chat, dependencies, fakeRelay, freshStore, gitRepository, now, project } from "./support";

process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-repository-list-config-"));

const query: MeshRepositoryQuery = {
  type: "mesh.repository.query", sessionId: "alpha", projectId: "alpha", requestId: "list-1", createdAt: now,
};

function bind(store: ReturnType<typeof freshStore>, projectId: string, root: string, endpointId = "mac") {
  const repositoryId = inspectRepository(root).canonicalRepositoryId;
  const bindingId = `binding-${projectId}-${endpointId}-${basename(root)}`;
  store.upsertBinding({ bindingId, projectId, endpointId, repositoryId, displayName: "bound", localPathHint: root, available: true });
  return bindingId;
}

test("the list names each repository on this computer once, bound ones first, with where each is bound", async () => {
  const store = freshStore();
  store.upsertProject(project("alpha", "Frontend"));
  store.upsertProject(project("beta", "Backend"));
  const zeta = gitRepository("zeta");
  const web = gitRepository("web");
  const api = gitRepository("api");
  const docs = gitRepository("docs");
  const cloneA = gitRepository("shared-main", "git@github.com:example/shared.git");
  const cloneB = gitRepository("shared-feature", "https://github.com/example/shared.git");
  const gone = gitRepository("gone");
  const zetaBinding = bind(store, "alpha", zeta.root);
  bind(store, "beta", api.root);
  bind(store, "alpha", gone.root);
  rmSync(gone.root, { recursive: true, force: true });
  bind(store, "alpha", docs.root, "other-mac");
  const plain = mkdtempSync(join(tmpdir(), "granttap-plain-folder-"));
  // A generator's throwaway folder, even one Git would call a checkout.
  const helper = mkdtempSync(join(tmpdir(), "hw-image-"));
  execFileSync("git", ["init", "-q", helper]);
  const { deps, sessions } = dependencies(store);
  sessions.push(
    chat("web-1", web.inner, now - 50), chat("web-2", web.root, now - 10),
    chat("zeta-1", zeta.inner, now - 5),
    chat("old-clone", cloneA.root, now - 100), chat("new-clone", cloneB.inner, now - 1),
    chat("plain", plain), chat("helper", helper), chat("gone", gone.root), chat("api", api.inner),
    { ...chat("no-folder", web.root), cwd: undefined },
  );
  const relay = fakeRelay();
  assert.equal(await handleMeshRepositoryRequest(relay.client, query, "phone", async () => {}, deps), true);
  const answer = relay.sent.find((item) => item.payload.type === "mesh.repository.list");
  assert.deepEqual([answer?.via, answer?.peer, answer?.reliable], ["project", "phone", false]);
  const list = answer?.payload as MeshRepositoryList;
  assert.equal(ListSchema.safeParse(list).success, true);
  assert.deepEqual([list.computerId, list.requestId, list.projectId, list.generatedAt], ["mac", "list-1", "alpha", now]);
  assert.deepEqual(list.repositories.map((item) => item.path), [zeta.root, api.root, cloneB.root, web.root],
    "bound here first, then by name; a missing checkout, a plain folder and a helper run are not listed");
  assert.deepEqual(list.repositories[0], { path: zeta.root, name: "zeta", repositoryId: inspectRepository(zeta.root).canonicalRepositoryId,
    boundHere: true, bindingId: zetaBinding });
  assert.deepEqual([list.repositories[1]?.otherProjectId, list.repositories[1]?.otherProjectName, list.repositories[1]?.boundHere],
    ["beta", "Backend", false]);
  assert.deepEqual([list.repositories[2]?.repositoryId, list.repositories[2]?.name], ["github.com/example/shared", "shared-feature"],
    "two clones of one repository are one row, where a chat worked last");
  assert.equal(list.repositories[3]?.bindingId, undefined);
});

test("a query is answered only for a Mesh this computer has, with the Mesh on, to its paired controller", async () => {
  const store = freshStore();
  store.upsertProject(project("alpha"));
  const relay = fakeRelay();
  const { deps } = dependencies(store);
  assert.equal(await handleMeshRepositoryRequest(relay.client, query, "stranger", async () => {}, deps), false);
  assert.equal(await handleMeshRepositoryRequest(relay.client, { ...query, createdAt: now - 200_000 }, "phone", async () => {}, deps), false);
  assert.equal(await handleMeshRepositoryRequest(relay.client, { ...query, sessionId: "gamma", projectId: "gamma" },
    "phone", async () => {}, deps), false);
  const off = dependencies(store, { meshEnabled: () => false }).deps;
  assert.equal(await handleMeshRepositoryRequest(relay.client, query, "phone", async () => {}, off), false);
  assert.equal(relay.sent.length, 0);
  assert.equal(await handleMeshRepositoryRequest(relay.client, query, "phone", async () => {}, deps), true);
  assert.deepEqual((relay.sent[0]?.payload as MeshRepositoryList).repositories, [], "nothing known is an empty list");
});
