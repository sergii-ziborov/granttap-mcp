import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isCursorHelperNode, resolveMonitorNodeBin } from "../apps/bridge/src/config/node-bin";
import { isEphemeralNpxInstall } from "../apps/mcp/src/http-service/common";

test("Cursor helper Node is rejected on macOS and Windows paths", () => {
  assert.equal(isCursorHelperNode("/Applications/Cursor.app/Contents/Resources/helpers/node"), true);
  assert.equal(
    isCursorHelperNode("C:\\Users\\Ada\\AppData\\Local\\Programs\\cursor\\resources\\app\\helpers\\node.exe"),
    true,
  );
  assert.equal(isCursorHelperNode("C:\\Program Files\\nodejs\\node.exe"), false);
});

test("resolveMonitorNodeBin honors GRANTTAP_NODE over Cursor helpers", () => {
  const previous = process.env.GRANTTAP_NODE;
  process.env.GRANTTAP_NODE = process.execPath;
  try {
    assert.equal(resolveMonitorNodeBin(), process.execPath);
  } finally {
    if (previous == null) delete process.env.GRANTTAP_NODE;
    else process.env.GRANTTAP_NODE = previous;
  }
});

test("ephemeral npx installs are detected on Unix and Windows cache paths", () => {
  assert.equal(isEphemeralNpxInstall("/Users/ada/.npm/_npx/abc123"), true);
  assert.equal(
    isEphemeralNpxInstall("C:\\Users\\Ada\\AppData\\Local\\npm-cache\\_npx\\abc123"),
    true,
  );
  assert.equal(isEphemeralNpxInstall("C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\granttap-mcp"), false);
});

test("Cursor plugin bootstrap is valid JavaScript and pins the published package", () => {
  const path = join(import.meta.dirname, "..", "cursor-plugin", "stdio-bootstrap.js");
  const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const source = readFileSync(path, "utf8");
  assert.match(source, /granttap-mcp@0\.8\.18/);
  assert.match(source, /ComSpec/);
  assert.match(source, /cmd\.exe/);
  assert.match(source, /where granttap-mcp/);
});
