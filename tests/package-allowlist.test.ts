import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { rejectedPackageEntries } from "../scripts/quality/package-allowlist.mjs";

test("publish allowlist rejects internal plans, tests, scripts, and agent guides", () => {
  const forbidden = [
    "tests/relay.test.ts",
    "scripts/release.ts",
    "AGENTS.md",
    "docs/superpowers/plan.md",
    "docs/roadmap.md",
    "docs/audits/security.md",
    "docs/research/providers.md",
    "docs/test-evidence/run.txt",
  ];
  assert.deepEqual(rejectedPackageEntries(forbidden), forbidden);
  assert.deepEqual(rejectedPackageEntries([
    "docs/cursor-authorize.md",
    "docs/images/iphone-task-detail.png",
  ]), []);
});

test("publish allowlist accepts the real npm tarball manifest", () => {
  const result = spawnSync("npm", ["run", "package:allowlist"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Package allowlist: accepted \d+ files/);
});
