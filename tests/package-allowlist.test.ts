import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  dryRunPackageEntries,
  rejectedPackageEntries,
} from "../scripts/quality/package-allowlist.mjs";

const repositoryRoot = join(import.meta.dirname, "..");
const ignoredReadmeDirectories = new Set([".git", "coverage", "node_modules", "target"]);

function readmeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredReadmeDirectories.has(entry.name) ? [] : readmeFiles(absolute);
    }
    return /^README.*\.md$/i.test(entry.name) ? [absolute] : [];
  });
}

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

test("public artifacts carry the GrantTap commercial license", () => {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ) as { license?: string };
  const pluginJson = JSON.parse(
    readFileSync(join(repositoryRoot, "cursor-plugin/.cursor-plugin/plugin.json"), "utf8"),
  ) as { license?: string };
  const license = readFileSync(join(repositoryRoot, "LICENSE"), "utf8");
  const workspace = readFileSync(join(repositoryRoot, "Cargo.toml"), "utf8");
  const crate = readFileSync(join(repositoryRoot, "crates/granttap-mcp/Cargo.toml"), "utf8");
  const entries = dryRunPackageEntries();

  assert.equal(packageJson.license, "SEE LICENSE IN LICENSE");
  assert.equal(pluginJson.license, "SEE LICENSE IN LICENSE");
  assert.match(license, /^GrantTap Commercial Source License 1\.0$/m);
  assert.match(workspace, /^license-file = "LICENSE"$/m);
  assert.match(crate, /^license-file\.workspace = true$/m);
  assert.ok(entries.includes("LICENSE"));
  assert.ok(entries.includes("THIRD_PARTY_NOTICES.md"));
  assert.ok(entries.includes("cursor-plugin/LICENSE"));
});

test("every repository README identifies the GrantTap commercial license", () => {
  const readmes = readmeFiles(repositoryRoot);
  assert.ok(readmes.length > 1);
  for (const readme of readmes) {
    assert.match(readFileSync(readme, "utf8"), /GrantTap Commercial Source License/);
  }
});
