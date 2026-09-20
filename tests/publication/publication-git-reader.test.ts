import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultPublicationGitReader } from "../../apps/bridge/src/publication/git-reader";

test("the publication git reader returns trimmed stdout or nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-pub-git-"));
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "ok\n");
  execFileSync("git", ["-C", root, "add", "README.md"], { stdio: "ignore" });
  const reader = defaultPublicationGitReader();
  assert.equal(reader.read(root, ["rev-parse", "--is-inside-work-tree"]), "true");
  assert.ok((reader.readRaw(root, ["status", "--porcelain"]) ?? "").includes("README.md"));
  assert.equal(reader.read(root, ["rev-parse", "no-such-ref"]), undefined);
  assert.equal(reader.read(join(root, "missing"), ["status"]), undefined);
});
