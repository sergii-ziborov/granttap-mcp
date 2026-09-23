#!/usr/bin/env node
"use strict";

// Cursor may start this MCP from any cwd. Execute JavaScript entry points with
// Node itself: Windows batch shims require shell quoting that differs by host.
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { delimiter, dirname, join } = require("node:path");

const PACKAGE = "granttap-mcp@0.8.19";
const dryRun = process.env.GRANTTAP_BOOTSTRAP_DRY_RUN === "1";
const platform = dryRun && process.env.GRANTTAP_BOOTSTRAP_PLATFORM
  ? process.env.GRANTTAP_BOOTSTRAP_PLATFORM : process.platform;
const nodeRoot = dryRun && process.env.GRANTTAP_BOOTSTRAP_NODE_ROOT
  ? process.env.GRANTTAP_BOOTSTRAP_NODE_ROOT : dirname(process.execPath);
const pathRoots = (process.env.PATH || "").split(delimiter).filter(Boolean);
const appData = process.env.APPDATA;
const roots = [nodeRoot, ...pathRoots, ...(appData ? [join(appData, "npm")] : [])];
const first = (paths) => paths.find((path) => existsSync(path));

function launch() {
  if (platform !== "win32") {
    const installed = first(roots.map((root) => join(root, "granttap-mcp")));
    if (installed) return { command: installed, args: [] };
    const npx = first(roots.map((root) => join(root, "npx"))) || "npx";
    return { command: npx, args: ["-y", PACKAGE] };
  }
  const installed = first(roots.map((root) =>
    join(root, "node_modules", "granttap-mcp", "bin", "granttap-mcp.mjs")));
  if (installed) return { command: process.execPath, args: [installed] };
  const npx = first(roots.map((root) =>
    join(root, "node_modules", "npm", "bin", "npx-cli.js")));
  if (npx) return { command: process.execPath, args: [npx, "-y", PACKAGE] };
  throw new Error("Node.js/npm 20+ is required on this Windows device. Install npm and retry GrantTap.");
}

let target;
try { target = launch(); }
catch (error) {
  process.stderr.write(`[granttap] ${error.message}\n`);
  process.exit(1);
}

if (dryRun) {
  process.stdout.write(JSON.stringify(target));
  process.exit(0);
}

const child = spawn(target.command, target.args, { stdio: "inherit", windowsHide: true });
child.on("error", (error) => {
  process.stderr.write(`[granttap] ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal && platform !== "win32") {
    try { process.kill(process.pid, signal); } catch { process.exit(code ?? 1); }
    return;
  }
  process.exit(code ?? 1);
});
