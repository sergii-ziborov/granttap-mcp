#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [command = "mcp", argument] = process.argv.slice(2);

let entry;
if (command === "mcp") {
  entry = join(root, "apps", "mcp", "src", "server.ts");
} else if (command === "setup") {
  entry = join(root, "apps", "bridge", "src", "bin", "setup.ts");
} else if (command === "hook" && (argument === "claude" || argument === "codex")) {
  entry = join(root, "apps", "bridge", "src", "bin", `${argument}-hook.ts`);
} else {
  process.stderr.write(
    [
      "Usage:",
      "  granttap-mcp                 Start the MCP stdio server",
      "  granttap-mcp setup           Install Claude Code and Codex approval hooks",
      "  granttap-mcp hook <agent>    Internal hook entry point",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const child = spawn(process.execPath, ["--import", "tsx", entry], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  process.stderr.write(`[granttap-mcp] ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
