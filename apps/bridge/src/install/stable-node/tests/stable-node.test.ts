import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { publishStableNode } from "..";

function root(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "granttap-stable-node-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("a coding app without a version manager on PATH can run this computer's Node", (t) => {
  const dir = root(t);
  publishStableNode(dir);
  const output = execFileSync("node", ["-p", "1 + 1"], {
    encoding: "utf8", env: { PATH: `/nonexistent:${join(dir, "bin")}` },
  });
  assert.equal(output.trim(), "2");
  assert.equal(statSync(join(dir, "bin")).mode & 0o777, 0o700, "the folder stays private");
});

test("a changed Node replaces the link, and an unchanged one leaves it alone", (t) => {
  const dir = root(t);
  publishStableNode(dir, "/first/node");
  publishStableNode(dir, "/first/node");
  assert.equal(readlinkSync(join(dir, "bin", "node")), "/first/node");
  publishStableNode(dir, "/second/node");
  assert.equal(readlinkSync(join(dir, "bin", "node")), "/second/node");
});

test("Windows keeps Node on PATH and gets no link", (t) => {
  const dir = root(t);
  publishStableNode(dir, "C:\\node.exe", "win32");
  assert.equal(existsSync(join(dir, "bin")), false);
});

test("a storage failure never stops the monitor from starting", (t) => {
  const file = join(root(t), "not-a-folder");
  writeFileSync(file, "");
  assert.doesNotThrow(() => publishStableNode(file));
});
