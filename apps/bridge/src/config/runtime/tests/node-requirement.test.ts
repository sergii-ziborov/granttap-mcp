import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isSupportedNode } from "../node-requirement.mjs";

const launcher = new URL("../../../../../../bin/granttap-mcp.mjs", import.meta.url);

for (const version of ["18.20.8", "20.19.0", "22.12.0"]) {
  test(`launcher rejects Node ${version} before loading or changing configuration`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "granttap-runtime-minimum-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const preload = `Object.defineProperty(process.versions, 'node', {value:${JSON.stringify(version)}})`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      launcher.pathname, "--help"], { cwd: home, encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /requires Node\.js 22\.13\.0 or newer/);
    assert.match(result.stderr, new RegExp(version.replaceAll(".", "\\.")));
    assert.deepEqual(readdirSync(home), []);
  });
}

test("launcher works on the supported runtime from another directory", () => {
  const result = spawnSync(process.execPath, [launcher.pathname, "--help"], { cwd: tmpdir(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GrantTap/);
});


test("runtime compatibility covers the minimum and future supported versions", () => {
  for (const version of ["22.13.0", "v22.13.0", "22.23.4", "24.0.0", "26.1.0"]) {
    assert.equal(isSupportedNode(version), true, version);
  }
  for (const version of ["", "garbage", "22.13", "22.13.0-rc.1", "21.99.99", "22.12.99"]) {
    assert.equal(isSupportedNode(version), false, version);
  }
});
