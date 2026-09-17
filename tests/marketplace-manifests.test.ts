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

test("Codex, Claude Code, and Grok Build use the same OAuth HTTP service", () => {
  const codex = readJson("plugins/granttap/.codex-plugin/plugin.json");
  const servers = codex.mcpServers as Record<string, { type: string; url: string }>;
  assert.deepEqual(servers, {
    granttap: { type: "http", url: "http://127.0.0.1:17342/mcp" },
  });
  const otherHosts = readJson("plugins/granttap/.mcp.json").mcpServers;
  assert.deepEqual(otherHosts, servers);
});

test("Cursor plugin ships Cloud stdio MCP without a workspace marketplace", () => {
  const plugin = readJson("cursor-plugin/.cursor-plugin/plugin.json");
  const mcp = readJson("cursor-plugin/mcp.json");
  assert.equal(plugin.name, "granttap");
  assert.equal(plugin.version, "0.1.9");
  assert.equal(plugin.logo, "assets/logo.svg");
  assert.deepEqual(mcp, {
    mcpServers: {
      granttap: { command: "node", args: ["stdio-bootstrap.js"] },
    },
  });
  assert.equal(existsSync(join(repositoryRoot, ".cursor-plugin/marketplace.json")), false);
  assert.equal(existsSync(join(repositoryRoot, "cursor-plugin/.cursor-plugin/marketplace.json")), false);
  assert.equal(existsSync(join(repositoryRoot, "cursor-plugin/.cursor-plugin/plugin.json")), true);
  assert.equal(existsSync(join(repositoryRoot, "cursor-plugin/mcp.json")), true);
  assert.equal(existsSync(join(repositoryRoot, "cursor-plugin/stdio-bootstrap.js")), true);
});

test("public install docs distinguish Git plugins from approved listings", () => {
  const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
  const pluginReadme = readFileSync(join(repositoryRoot, "plugins/granttap/README.md"), "utf8");
  const cursorReadme = readFileSync(join(repositoryRoot, "cursor-plugin/README.md"), "utf8");

  assert.match(readme, /grok plugin marketplace add sergii-ziborov\/granttap-mcp/);
  assert.match(readme, /grok plugin install granttap --trust/);
  assert.match(readme, /reviewed \*\*GrantTap\*\* Marketplace listing/);
  assert.match(pluginReadme, /grok plugin marketplace add sergii-ziborov\/granttap-mcp/);
  assert.match(pluginReadme, /grok plugin install granttap --trust/);
  assert.match(cursorReadme, /plugin source is public and MIT-licensed/);
  assert.match(cursorReadme, /Marketplace listings require Cursor's\s+review/);
  assert.match(cursorReadme, /Git import does not automatically receive marketplace updates/);
});
