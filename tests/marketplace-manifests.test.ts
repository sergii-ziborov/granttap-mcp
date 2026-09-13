import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = join(import.meta.dirname, "..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8")) as Record<string, unknown>;
}

test("Grok marketplace indexes the GrantTap plugin", () => {
  const marketplace = readJson(".grok-plugin/marketplace.json");
  const plugins = marketplace.plugins as Array<{ name: string; source: { type: string; path: string } }>;
  assert.equal(marketplace.name, "granttap");
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]?.name, "granttap");
  assert.equal(plugins[0]?.source.type, "local");
  assert.equal(plugins[0]?.source.path, "./plugins/granttap");
  assert.equal(existsSync(join(repositoryRoot, "plugins/granttap/.grok-plugin/plugin.json")), true);
  assert.equal(existsSync(join(repositoryRoot, "plugins/granttap/.mcp.json")), true);
});

test("Codex plugin declares OAuth HTTP without replacing Claude and Grok stdio", () => {
  const codex = readJson("plugins/granttap/.codex-plugin/plugin.json");
  const servers = codex.mcpServers as Record<string, { type: string; url: string }>;
  assert.deepEqual(servers, {
    granttap: { type: "http", url: "http://127.0.0.1:17342/mcp" },
  });
  const otherHosts = readJson("plugins/granttap/.mcp.json").mcpServers as Record<string, { command: string }>;
  assert.ok(otherHosts.granttap);
  assert.equal(otherHosts.granttap.command, "npx");
});

test("Cursor marketplace indexes the GrantTap plugin at the repository root", () => {
  const marketplace = readJson(".cursor-plugin/marketplace.json");
  const plugins = marketplace.plugins as Array<{ name: string; source: string }>;
  assert.equal(marketplace.name, "granttap");
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]?.name, "granttap");
  assert.equal(plugins[0]?.source, "cursor-plugin");
  assert.equal(existsSync(join(repositoryRoot, "cursor-plugin/.cursor-plugin/plugin.json")), true);
  assert.equal(existsSync(join(repositoryRoot, "cursor-plugin/mcp.json")), true);
});

test("public install docs include Grok Build and Cursor marketplace entry points", () => {
  const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
  const pluginReadme = readFileSync(join(repositoryRoot, "plugins/granttap/README.md"), "utf8");
  const cursorReadme = readFileSync(join(repositoryRoot, "cursor-plugin/README.md"), "utf8");

  assert.match(readme, /grok plugin marketplace add sergii-ziborov\/granttap-mcp/);
  assert.match(readme, /grok plugin install granttap --trust/);
  assert.match(readme, /Cursor plugin marketplace/);
  assert.match(pluginReadme, /grok plugin marketplace add sergii-ziborov\/granttap-mcp/);
  assert.match(pluginReadme, /grok plugin install granttap --trust/);
  assert.match(cursorReadme, /Cursor's plugin marketplace/);
});
