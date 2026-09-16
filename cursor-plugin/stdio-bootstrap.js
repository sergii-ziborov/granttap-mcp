#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");

const PACKAGE = "granttap-mcp@0.8.18";
const windows = process.platform === "win32";
const command = windows ? (process.env.ComSpec || "cmd.exe") : "npx";
const args = windows
  ? ["/d", "/s", "/c", `where granttap-mcp >nul 2>nul && granttap-mcp || npx -y ${PACKAGE}`]
  : ["-y", PACKAGE];
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
