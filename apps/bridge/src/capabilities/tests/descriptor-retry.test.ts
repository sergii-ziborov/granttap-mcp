import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descriptorsForProvider } from "../descriptors";

test("a failed Codex descriptor lookup is shared by every chat in the catalog", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-descriptor-retry-"));
  const binary = join(root, "codex");
  const counter = join(root, "calls");
  writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
const file = process.env.GRANTTAP_DESCRIPTOR_TEST_COUNTER;
const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
fs.writeFileSync(file, String(count + 1));
process.exit(1);
`, { mode: 0o700 });
  const prior = process.env.GRANTTAP_CODEX_BIN;
  const priorCounter = process.env.GRANTTAP_DESCRIPTOR_TEST_COUNTER;
  process.env.GRANTTAP_CODEX_BIN = binary;
  process.env.GRANTTAP_DESCRIPTOR_TEST_COUNTER = counter;
  t.after(() => {
    if (prior == null) delete process.env.GRANTTAP_CODEX_BIN;
    else process.env.GRANTTAP_CODEX_BIN = prior;
    if (priorCounter == null) delete process.env.GRANTTAP_DESCRIPTOR_TEST_COUNTER;
    else process.env.GRANTTAP_DESCRIPTOR_TEST_COUNTER = priorCounter;
    rmSync(root, { recursive: true, force: true });
  });
  for (let chat = 0; chat < 10; chat++) {
    assert.deepEqual(descriptorsForProvider("codex", root), []);
  }
  assert.equal(Number(readFileSync(counter, "utf8")), 1);
  const nextAttempt = Date.now() + 31_000;
  t.mock.method(Date, "now", () => nextAttempt);
  assert.deepEqual(descriptorsForProvider("codex", root), []);
  assert.equal(Number(readFileSync(counter, "utf8")), 2);
});
