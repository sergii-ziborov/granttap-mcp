import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAccountLink, saveAccountLink } from "../link";

test("account link persists one private machine credential and rejects malformed replacement", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-account-link-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR; await rm(root, { recursive: true, force: true }); });
  const link = { accountId: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222", machineToken: "A".repeat(43) };
  assert.equal(loadAccountLink(), null);
  assert.equal(saveAccountLink(link), true);
  assert.deepEqual(loadAccountLink(), link);
  assert.equal(saveAccountLink({ ...link, machineToken: "bad" }), false);
  assert.deepEqual(loadAccountLink(), link);
});
