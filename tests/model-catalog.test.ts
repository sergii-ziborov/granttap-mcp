import assert from "node:assert/strict";
import test from "node:test";
import { allowedModelIds, catalogFromSessions } from "../apps/bridge/src/mesh/model-catalog";

test("two machines keep separate model catalogs", () => {
  const macA = catalogFromSessions("mac-a", [
    { agent: "claude", computerId: "mac-a", model: "sonnet", lastActivityAt: 10 },
    { agent: "codex", computerId: "mac-b", model: "gpt-5.5", lastActivityAt: 11 },
  ], 20);
  const macB = catalogFromSessions("mac-b", [
    { agent: "claude", computerId: "mac-a", model: "sonnet", lastActivityAt: 10 },
    { agent: "codex", computerId: "mac-b", model: "gpt-5.5", lastActivityAt: 11 },
  ], 20);
  assert.deepEqual(macA.models.map((item) => item.modelId), ["sonnet"]);
  assert.deepEqual(macB.models.map((item) => item.modelId), ["gpt-5.5"]);
  assert.equal(allowedModelIds(macB, ["sonnet"]).length, 0);
});

test("an empty catalog is reported, not filled from a static fallback", () => {
  const catalog = catalogFromSessions("mac-a", [{ agent: "cursor", computerId: "mac-a" }], 1);
  assert.equal(catalog.models.length, 0);
  assert.equal(catalog.reason, "not_reported");
});
