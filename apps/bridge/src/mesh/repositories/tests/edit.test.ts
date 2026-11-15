import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MeshRepositoryEdit, MeshRepositoryEditResult } from "../../../../../../packages/protocol/schema";
import { MeshRepositoryEditResult as ResultSchema } from "../../../../../../packages/protocol/schema";
import { inspectRepository } from "../../catalog";
import { projectBindingIdentity } from "../../identity";
import { handleMeshRepositoryRequest, resetRepositoryRequests } from "..";
import { EDIT_MEMORY_MS, MAX_REMEMBERED_EDITS } from "../requests";
import { dependencies, fakeRelay, freshStore, gitRepository, now, project } from "./support";

process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-repository-edit-config-"));

let counter = 0;
function edit(fields: Partial<MeshRepositoryEdit> & Pick<MeshRepositoryEdit, "action">): MeshRepositoryEdit {
  counter += 1;
  return { type: "mesh.repository.edit", sessionId: "alpha", projectId: "alpha", requestId: `edit-${counter}`,
    createdAt: now, ...fields } as MeshRepositoryEdit;
}

function results(sent: ReturnType<typeof fakeRelay>["sent"]) {
  return sent.filter((item) => item.payload.type === "mesh.repository.edit.result")
    .map((item) => ({ ...item, result: item.payload as MeshRepositoryEditResult }));
}

function meshes() {
  const store = freshStore();
  store.upsertProject(project("alpha", "Frontend"));
  store.upsertProject(project("beta", "Backend"));
  return store;
}

test("only a paired controller, asking now, is answered", async (t) => {
  t.after(resetRepositoryRequests);
  const store = meshes();
  const { deps } = dependencies(store);
  const relay = fakeRelay();
  const { root } = gitRepository();
  const request = edit({ action: "add", path: root });
  const publish = async () => {};
  assert.equal(await handleMeshRepositoryRequest(relay.client, request, undefined, publish, deps), false);
  assert.equal(await handleMeshRepositoryRequest(relay.client, request, "stranger", publish, deps), false);
  assert.equal(await handleMeshRepositoryRequest(fakeRelay("other-room").client, request, "phone", publish, deps), false);
  assert.equal(await handleMeshRepositoryRequest(relay.client, { ...request, createdAt: now - 120_001 }, "phone", publish, deps), false);
  assert.equal(await handleMeshRepositoryRequest(relay.client, { ...request, createdAt: now + 120_001 }, "phone", publish, deps), false);
  assert.equal(relay.sent.length, 0, "nothing is said to a stranger or to a stale request");
  assert.equal(store.endpointBindings("mac").length, 0);
});

test("a checkout is added by any folder inside it, once, and the Mesh is published again", async (t) => {
  t.after(resetRepositoryRequests);
  const store = meshes();
  const { deps, lines } = dependencies(store);
  const relay = fakeRelay();
  let published = 0;
  const publish = async () => { published += 1; };
  const { root, inner } = gitRepository("web");
  const request = edit({ action: "add", path: inner });
  assert.equal(await handleMeshRepositoryRequest(relay.client, request, "phone", publish, deps), true);
  const [answer] = results(relay.sent);
  const repositoryId = inspectRepository(root).canonicalRepositoryId;
  const bindingId = projectBindingIdentity("alpha", "mac", repositoryId);
  assert.deepEqual(answer?.result, { type: "mesh.repository.edit.result", sessionId: "alpha", projectId: "alpha",
    requestId: request.requestId, action: "add", ok: true, bindingId, generatedAt: now });
  assert.equal(ResultSchema.safeParse(answer?.result).success, true);
  assert.deepEqual([answer?.via, answer?.peer], ["project", "phone"], "under the Project key, to the phone that asked");
  assert.deepEqual(relay.grants, [{ sessionId: "alpha", peer: "phone" }]);
  const bound = store.endpointBindings("mac")[0];
  assert.deepEqual([bound?.projectId, bound?.localPathHint, bound?.displayName, bound?.available], ["alpha", root, "web", true]);
  assert.equal(published, 1);
  assert.match(lines[0] ?? "", /added to alpha by the person/);

  // The same repository asked for again is already there: a success that changes nothing.
  await handleMeshRepositoryRequest(relay.client, edit({ action: "add", path: root }), "phone", publish, deps);
  const again = results(relay.sent)[1]?.result;
  assert.deepEqual([again?.ok, again?.reason, again?.bindingId], [true, "already-bound", bindingId]);
  assert.equal(published, 1);
  // In another Mesh on this computer it stays where it is.
  await handleMeshRepositoryRequest(relay.client, edit({ action: "add", path: root, sessionId: "beta", projectId: "beta" }),
    "phone", publish, deps);
  const elsewhere = results(relay.sent)[2]?.result;
  assert.deepEqual([elsewhere?.ok, elsewhere?.reason], [false, "bound-elsewhere"]);
  assert.match(elsewhere?.detail ?? "", /"Frontend"/);
  assert.equal(store.endpointBindings("mac").length, 1);
});

test("an add names a real checkout by its full path", async (t) => {
  t.after(resetRepositoryRequests);
  const store = meshes();
  const { deps } = dependencies(store);
  const relay = fakeRelay();
  const plain = mkdtempSync(join(tmpdir(), "granttap-not-a-checkout-"));
  mkdirSync(join(plain, "folder"));
  writeFileSync(join(plain, "file.txt"), "text");
  const cases: Array<[Partial<MeshRepositoryEdit>, string]> = [
    [{}, "invalid"], [{ path: "relative/app" }, "invalid"],
    [{ path: join(plain, "missing") }, "not-found"],
    [{ path: join(plain, "folder") }, "not-a-repository"], [{ path: join(plain, "file.txt") }, "not-a-repository"],
  ];
  for (const [fields] of cases) {
    await handleMeshRepositoryRequest(relay.client, edit({ action: "add", ...fields }), "phone", async () => {}, deps);
  }
  assert.deepEqual(results(relay.sent).map((item) => item.result.reason), cases.map(([, reason]) => reason));
  assert.equal(results(relay.sent).every((item) => !item.result.ok && (item.result.detail?.length ?? 0) > 0), true);
  assert.equal(store.endpointBindings("mac").length, 0);
  // A stable binding id already naming another repository is refused rather than overwritten.
  const { root } = gitRepository("clash");
  const id = projectBindingIdentity("alpha", "mac", inspectRepository(root).canonicalRepositoryId);
  store.upsertBinding({ bindingId: id, projectId: "alpha", endpointId: "other-mac", repositoryId: "other", displayName: "other", available: true });
  await handleMeshRepositoryRequest(relay.client, edit({ action: "add", path: root }), "phone", async () => {}, deps);
  assert.equal(results(relay.sent).at(-1)?.result.reason, "failed");
});

test("a computer removes its own binding and keeps it out; another computer's, or the last one, it refuses", async (t) => {
  t.after(resetRepositoryRequests);
  const store = meshes();
  const { deps } = dependencies(store);
  const relay = fakeRelay();
  let published = 0;
  const publish = async () => { published += 1; };
  const binding = (endpointId: string, repositoryId: string) => ({
    bindingId: `binding-${endpointId}-${repositoryId}`, projectId: "alpha", endpointId, repositoryId,
    displayName: repositoryId, localPathHint: `/work/${repositoryId}`, available: true,
  });
  store.upsertBinding(binding("mac", "app"));
  const send = (fields: Partial<MeshRepositoryEdit>) =>
    handleMeshRepositoryRequest(relay.client, edit({ action: "remove", ...fields }), "phone", publish, deps);
  await send({ bindingId: "binding-mac-app" });
  store.upsertBinding(binding("other-mac", "api"));
  await send({ bindingId: "binding-other-mac-api" });
  await send({});
  await send({ bindingId: "binding-unknown" });
  await send({ bindingId: "binding-mac-app" });
  assert.deepEqual(results(relay.sent).map((item) => [item.result.ok, item.result.reason ?? null]), [
    [false, "last-repository"], [false, "not-this-computer"], [false, "invalid"], [false, "not-found"], [true, null],
  ]);
  assert.equal(results(relay.sent).at(-1)?.result.bindingId, "binding-mac-app");
  assert.equal(published, 1, "only the removal changed the Mesh");
  assert.equal(store.bindingRemoved("alpha", "mac", "app"), true);
  assert.deepEqual(store.snapshot("alpha")?.bindings?.map((item) => item.bindingId), ["binding-other-mac-api"]);
});

test("a Mesh that is off, or not on this computer, is said so without minting a key for it", async (t) => {
  t.after(resetRepositoryRequests);
  const store = meshes();
  const relay = fakeRelay();
  const off = dependencies(store, { meshEnabled: () => false }).deps;
  await handleMeshRepositoryRequest(relay.client, edit({ action: "add", path: "/work/app" }), "phone", async () => {}, off);
  const { deps } = dependencies(store);
  await handleMeshRepositoryRequest(relay.client, edit({ action: "remove", bindingId: "binding", sessionId: "gamma", projectId: "gamma" }),
    "phone", async () => {}, deps);
  await handleMeshRepositoryRequest(relay.client, edit({ action: "add", path: "/work/app", sessionId: "gamma", projectId: "gamma" }),
    "phone", async () => {}, off);
  assert.deepEqual(results(relay.sent).map((item) => [item.result.reason, item.via]), [
    ["mesh-disabled", "project"], ["unknown-mesh", "pairing"], ["mesh-disabled", "pairing"],
  ]);
  assert.deepEqual(relay.grants.map((item) => item.sessionId), ["alpha"], "no key for a Project this computer does not have");
  const broken = dependencies(store, { endpoint: () => { throw new Error("identity unavailable"); } }).deps;
  await handleMeshRepositoryRequest(relay.client, edit({ action: "remove", bindingId: "binding" }), "phone", async () => {}, broken);
  assert.equal(results(relay.sent).at(-1)?.result.reason, "failed");
});

test("a repeated request is given the first answer, and the edit is made once", async (t) => {
  t.after(resetRepositoryRequests);
  const store = meshes();
  let clock = now;
  const { deps } = dependencies(store, { now: () => clock });
  const relay = fakeRelay();
  let published = 0;
  const publish = async () => { published += 1; };
  const { root } = gitRepository("api");
  const request = edit({ action: "add", path: root });
  await handleMeshRepositoryRequest(relay.client, request, "phone", publish, deps);
  clock += 30_000;
  // Sent again with a later time, as a phone that reconnected would.
  assert.equal(await handleMeshRepositoryRequest(relay.client, { ...request, createdAt: clock }, "phone", publish, deps), true);
  const [first, second] = results(relay.sent);
  assert.deepEqual(second?.result, first?.result, "the same answer, generated when the edit was made");
  assert.equal(published, 1);
  assert.equal(await handleMeshRepositoryRequest(relay.client, { ...request, path: join(root, "src") }, "phone", publish, deps), false,
    "another edit under a used id is not answered");
  assert.equal(results(relay.sent).length, 2);
  // Another phone's request with the same id is its own.
  const other = dependencies(store, { now: () => clock, paired: () => true }).deps;
  await handleMeshRepositoryRequest(relay.client, request, "tablet", publish, other);
  assert.equal(results(relay.sent).at(-1)?.result.reason, "already-bound");
  // Remembered for ten minutes, then the id is free again.
  clock += EDIT_MEMORY_MS + 1;
  await handleMeshRepositoryRequest(relay.client, { ...request, createdAt: clock }, "phone", publish, deps);
  assert.equal(results(relay.sent).at(-1)?.result.generatedAt, clock);
  // The oldest answer gives way when many are remembered.
  for (let index = 0; index <= MAX_REMEMBERED_EDITS; index += 1) {
    await handleMeshRepositoryRequest(relay.client, edit({ action: "remove", bindingId: `binding-${index}`, createdAt: clock }),
      "phone", publish, deps);
  }
  assert.equal(published, 1);
});
