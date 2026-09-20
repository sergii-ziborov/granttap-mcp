import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { isCursorHelperNode, resolveMonitorNodeBin } from "../../apps/bridge/src/config/runtime/node-bin";
import { isEphemeralNpxInstall } from "../../apps/mcp/src/http-service/common";

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

test("Cursor plugin bootstrap is valid JavaScript and pins the verified runtime archive", () => {
  const path = join(import.meta.dirname, "../..", "cursor-plugin", "stdio-bootstrap.cjs");
  const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const source = readFileSync(path, "utf8");
  assert.match(source, /https:\/\/github\.com\/sergii-ziborov\/granttap-mcp\/archive\/[0-9a-f]{40}\.tar\.gz/);
  assert.match(source, /ComSpec/);
  assert.match(source, /cmd\.exe/);
  assert.match(source, /where granttap-mcp/);
});

test("Cursor plugin MCP starts from a foreign cwd, unlike a relative bootstrap path", () => {
  const plugin = join(import.meta.dirname, "../..", "cursor-plugin");
  const mcp = JSON.parse(readFileSync(join(plugin, "mcp.json"), "utf8")) as {
    mcpServers: { granttap: { type?: string; url?: string; command?: string; args?: string[] } };
  };
  const cwd = mkdtempSync(join(tmpdir(), "granttap-stdio-cwd-"));
  const env = { ...process.env, GRANTTAP_BOOTSTRAP_DRY_RUN: "1" };
  const relative = spawnSync(process.execPath, ["stdio-bootstrap.js"], {
    cwd, env, encoding: "utf8",
  });
  assert.notEqual(relative.status, 0);
  assert.match(`${relative.stderr}${relative.stdout}`, /Cannot find module|MODULE_NOT_FOUND/i);

  // Cursor Cloud cannot fetch 127.0.0.1. The plugin is stdio; cwd must not matter.
  assert.equal(mcp.mcpServers.granttap.command, "node");
  assert.equal(mcp.mcpServers.granttap.args?.[0], "-e");
  const source = readFileSync(join(plugin, "stdio-bootstrap.cjs"), "utf8");
  const archive = source.match(/https:\/\/github\.com\/sergii-ziborov\/granttap-mcp\/archive\/[0-9a-f]{40}\.tar\.gz/)?.[0];
  assert.ok(archive, "the standalone bootstrap pins a Git commit archive");
  assert.ok((mcp.mcpServers.granttap.args?.[1] ?? "").includes(archive));
  assert.equal(mcp.mcpServers.granttap.url, undefined);
  assert.equal(mcp.mcpServers.granttap.type, undefined);
  assert.doesNotThrow(() => new Script(mcp.mcpServers.granttap.args?.[1] ?? ""));

  const absolute = spawnSync(process.execPath, [join(plugin, "stdio-bootstrap.cjs")], {
    cwd, env, encoding: "utf8",
  });
  assert.equal(absolute.status, 0, absolute.stderr);
  const launched = JSON.parse(absolute.stdout) as { command: string; args: string[] };
  assert.equal(typeof launched.command, "string");
  assert.equal(Array.isArray(launched.args), true);
});
