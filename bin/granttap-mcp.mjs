#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [command = "mcp", argument] = process.argv.slice(2);

const usage = [
  "Usage:",
  "  granttap                    Start the MCP stdio server",
  "  granttap serve              HTTP MCP + OAuth (Cursor Settings → Authorize)",
  "  granttap authorize          Configure Cursor + start local OAuth in one step",
  "  granttap connect [url]      Pair this machine with iPhone/Apple Watch",
  "  granttap setup              Install Cursor, Claude, and Codex policy hooks",
  "  granttap status [--json]    Read-only provider and pairing readiness",
  "  granttap web                Print the private Web capability on request",
  "  granttap monitor            Internal background task sync",
  "  granttap hook <agent>       Internal hook entry point",
  "",
  "The legacy granttap-mcp command is an alias for granttap.",
  "",
].join("\n");

if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(usage);
  process.exit(0);
}

let entry;
if (command === "mcp") {
  entry = join(root, "apps", "mcp", "src", "server.ts");
} else if (command === "serve" || command === "http") {
  entry = join(root, "apps", "mcp", "src", "bin", "serve.ts");
} else if (command === "authorize") {
  entry = join(root, "apps", "mcp", "src", "bin", "authorize.ts");
} else if (command === "setup") {
  entry = join(root, "apps", "bridge", "src", "bin", "setup.ts");
} else if (command === "connect") {
  entry = join(root, "apps", "bridge", "src", "bin", "connect.ts");
} else if (command === "status") {
  entry = join(root, "apps", "mcp", "src", "bin", "status.ts");
} else if (command === "web") {
  entry = join(root, "apps", "bridge", "src", "bin", "web.ts");
} else if (command === "monitor") {
  entry = join(root, "apps", "bridge", "src", "bin", "monitor.ts");
} else if (command === "hook" && [
  "claude", "codex", "codex-policy", "cursor", "cursor-after", "cursor-mcp",
].includes(argument)) {
  const hookEntry = argument === "codex-policy"
    ? "codex-policy-hook.ts"
    : argument === "cursor-after"
      ? "cursor-after-shell.ts"
      : argument === "cursor-mcp"
        ? "cursor-mcp-hook.ts"
        : `${argument}-hook.ts`;
  entry = join(root, "apps", "bridge", "src", "bin", hookEntry);
} else {
  process.stderr.write(usage);
  process.exit(1);
}

// Cursor (and LaunchAgents) often spawn with cwd=$HOME. Bare `--import tsx` then
// resolves from home and dies with ERR_MODULE_NOT_FOUND. Pin absolute loaders + cwd.
const requireFromBin = createRequire(import.meta.url);
let preflight;
let loader;
try {
  // npm may place dependencies beside this package or hoist them into an
  // ancestor node_modules. Resolve from the installed bin instead of assuming
  // a package-local node_modules directory.
  preflight = requireFromBin.resolve("tsx/preflight");
  loader = requireFromBin.resolve("tsx");
} catch {
  // Keep source-checkout compatibility with older tsx releases that did not
  // expose these subpaths through package exports.
  const localPreflight = join(root, "node_modules", "tsx", "dist", "preflight.cjs");
  const localLoader = join(root, "node_modules", "tsx", "dist", "loader.mjs");
  if (existsSync(localPreflight) && existsSync(localLoader)) {
    preflight = localPreflight;
    loader = localLoader;
  }
}
if (!preflight || !loader) {
  process.stderr.write(
    "[granttap-mcp] unable to resolve the installed tsx runtime — reinstall granttap-mcp\n",
  );
  process.exit(1);
}

const forwardedArgs = command === "connect" || command === "status" ? process.argv.slice(3) : [];
const child = spawn(
  process.execPath,
  ["--require", preflight, "--import", pathToFileURL(loader).href, entry, ...forwardedArgs],
  {
    stdio: "inherit",
    cwd: root,
    env: {
      ...process.env,
      NODE_PATH: [join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(":"),
    },
  },
);

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
