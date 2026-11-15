import assert from "node:assert/strict";
import test from "node:test";
import {
  MeshRepositoryCandidate,
  MeshRepositoryEdit,
  MeshRepositoryEditResult,
  MeshRepositoryList,
  MeshRepositoryQuery,
  Payload,
} from "../../../../schema";

const at = 1_800_000_000_000;
const query = { type: "mesh.repository.query", sessionId: "mesh-a", projectId: "mesh-a", requestId: "q-1", createdAt: at };
const bound = { path: "/Users/me/dev/app", name: "app", repositoryId: "github.com/me/app", boundHere: true, bindingId: "binding-1" };
const elsewhere = { path: "C:\\work\\api", name: "api", repositoryId: "local:C:\\work\\api", boundHere: false,
  otherProjectId: "mesh-b", otherProjectName: "Backend" };
const list = { type: "mesh.repository.list", sessionId: "mesh-a", projectId: "mesh-a", requestId: "q-1",
  computerId: "studio", repositories: [bound, elsewhere], generatedAt: at };
const edit = { type: "mesh.repository.edit", sessionId: "mesh-a", projectId: "mesh-a", requestId: "e-1",
  createdAt: at, action: "add", path: "/Users/me/dev/app" };
const result = { type: "mesh.repository.edit.result", sessionId: "mesh-a", projectId: "mesh-a", requestId: "e-1",
  action: "add", ok: true, bindingId: "binding-1", generatedAt: at };

test("the repository messages are part of the encrypted protocol", () => {
  for (const value of [query, list, edit, result]) assert.equal(Payload.parse(value).type, value.type);
  assert.equal(MeshRepositoryEdit.safeParse({ ...edit, action: "remove", path: undefined, bindingId: "binding-1" }).success, true);
  assert.equal(MeshRepositoryList.safeParse({ ...list, repositories: [] }).success, true);
  assert.equal(MeshRepositoryCandidate.safeParse({ ...elsewhere, path: "\\\\server\\share\\api" }).success, true,
    "a UNC share names its own root");
  assert.equal(MeshRepositoryCandidate.safeParse({ ...elsewhere, otherProjectName: undefined }).success, true);
  assert.equal(MeshRepositoryEditResult.safeParse({ ...result, reason: "already-bound", detail: "Already here." }).success, true);
  assert.equal(MeshRepositoryEditResult.safeParse({ ...result, ok: false, reason: "last-repository", bindingId: undefined }).success, true);
});

test("every repository message is scoped to the Project it names", () => {
  for (const value of [query, list, edit, result]) {
    assert.equal(Payload.safeParse({ ...value, sessionId: "mesh-b" }).success, false, `${value.type} out of scope`);
  }
  assert.equal(MeshRepositoryQuery.safeParse({ ...query, requestId: "" }).success, false);
  assert.equal(MeshRepositoryQuery.safeParse({ ...query, requestId: "r".repeat(129) }).success, false);
  assert.equal(MeshRepositoryQuery.safeParse({ ...query, createdAt: -1 }).success, false);
  assert.equal(MeshRepositoryQuery.safeParse({ ...query, extra: true }).success, false, "strict");
});

test("a listed checkout says plainly where it is bound", () => {
  assert.equal(MeshRepositoryCandidate.safeParse({ ...bound, bindingId: undefined }).success, false, "bound here names its binding");
  assert.equal(MeshRepositoryCandidate.safeParse({ ...elsewhere, bindingId: "binding-2" }).success, false,
    "a binding id is only for a binding here");
  assert.equal(MeshRepositoryCandidate.safeParse({ ...bound, otherProjectId: "mesh-b" }).success, false);
  assert.equal(MeshRepositoryCandidate.safeParse({ ...elsewhere, otherProjectId: undefined }).success, false,
    "a name without its Project");
  assert.equal(MeshRepositoryCandidate.safeParse({ ...bound, path: "dev/app" }).success, false, "absolute paths only");
  assert.equal(MeshRepositoryCandidate.safeParse({ ...bound, name: "" }).success, false);
  assert.equal(MeshRepositoryList.safeParse({ ...list, repositories: [bound, bound] }).success, false, "one row per checkout");
  const many = Array.from({ length: 201 }, (_, index) => ({ ...elsewhere, path: `/r/${index}` }));
  assert.equal(MeshRepositoryList.safeParse({ ...list, repositories: many }).success, false, "at most 200 checkouts");
  assert.equal(MeshRepositoryList.safeParse({ ...list, repositories: many.slice(1) }).success, true);
});

test("an edit result is a success or a refusal that says why", () => {
  assert.equal(MeshRepositoryEditResult.safeParse({ ...result, ok: false }).success, false, "a refusal says why");
  assert.equal(MeshRepositoryEditResult.safeParse({ ...result, reason: "bound-elsewhere" }).success, false,
    "only already-bound rides on a success");
  assert.equal(MeshRepositoryEditResult.safeParse({ ...result, ok: false, reason: "busy" }).success, false);
  assert.equal(MeshRepositoryEditResult.safeParse({ ...result, detail: "d".repeat(301) }).success, false);
  assert.equal(MeshRepositoryEditResult.safeParse({ ...result, detail: "d".repeat(300) }).success, true);
  assert.equal(MeshRepositoryEdit.safeParse({ ...edit, action: "move" }).success, false);
});
