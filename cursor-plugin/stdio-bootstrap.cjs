#!/usr/bin/env node
"use strict";

// Cursor starts plugin MCP with cwd=$HOME, so mcp.json cannot use a relative
// script path. This file is the readable form of that spawn. The plugin entry
// inlines the same logic via `node -e` so it does not depend on cwd.
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PACKAGE = "https://github.com/sergii-ziborov/granttap-mcp/archive/04884afd79fd0b8e3136a5ee6a8a3105fc9ba9e3.tar.gz";
const windows = process.platform === "win32";
const sibling = (name) => {
  const candidate = join(dirname(process.execPath), name);
  return existsSync(candidate) ? candidate : "";
};
const granttap = windows
  ? sibling("granttap-mcp.cmd") || sibling("granttap-mcp")
  : sibling("granttap-mcp");
const npx = windows ? sibling("npx.cmd") || sibling("npx") : sibling("npx");
const command = windows ? (process.env.ComSpec || "cmd.exe") : (granttap || npx || "npx");
const args = windows
  ? [
    "/d",
    "/s",
    "/c",
    granttap
      ? `"${granttap}"`
      : `where granttap-mcp >nul 2>nul && granttap-mcp || "${npx || "npx"}" -y ${PACKAGE}`,
  ]
  : granttap
    ? []
    : ["-y", PACKAGE];

if (process.env.GRANTTAP_BOOTSTRAP_DRY_RUN === "1") {
  process.stdout.write(JSON.stringify({ command, args }));
  process.exit(0);
}

const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
child.on("error", (error) => {
  process.stderr.write(`[granttap] ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal && process.platform !== "win32") {
    try { process.kill(process.pid, signal); } catch { process.exit(code ?? 1); }
    return;
  }
  process.exit(code ?? 1);
});
