#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { selectedRuntime, runtimeVersion, rollbackRuntime } from "../apps/bridge/src/runtime-updates/selection.mjs";
import { superviseRuntime } from "../apps/bridge/src/runtime-updates/supervision.mjs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isSupportedNode, minimumNodeVersion } from "../apps/bridge/src/config/runtime/node-requirement.mjs";

if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(`[granttap-mcp] requires Node.js ${minimumNodeVersion} or newer; found ${process.versions.node}. Install the latest supported Node.js LTS release.\n`);
  process.exit(1);
}

const bundledRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const updateDirectory = join(process.env.GRANTTAP_CONFIG_DIR ?? process.env.NODVOX_CONFIG_DIR
  ?? join(homedir(), ".granttap"), "runtime-updates");
const managed = bundledRoot.includes("node_modules") && process.env.GRANTTAP_LOCAL !== "1"
  && process.env.GRANTTAP_DISABLE_AUTO_UPDATE !== "1" && !process.env.NODE_TEST_CONTEXT;
const root = managed ? selectedRuntime(bundledRoot, updateDirectory) : bundledRoot;
const [command = "mcp", ...commandArgs] = process.argv.slice(2);
const argument = commandArgs[0];

const usage = [
  "GrantTap — personal control center for local coding agents",
  "",
  "Usage:",
  "  granttap setup                    Detect agents and install or repair GrantTap",
  "  granttap status [--json]          Show pairing, helper, and provider readiness",
  "  granttap connect [--relay <url>]  Pair this computer with iPhone/Apple Watch",
  "  granttap phone add              Show a QR for another controller phone",
  "  granttap phone reconnect        Show a QR to restore the same phone",
  "  granttap reset [--yes]            Reset this computer's phone pairing",
  "  granttap mesh connect <invite>    Redeem a one-time Grok Bot Mesh invite",
  "  granttap restrictions check [dir] Check files against Mesh / .granttap restrictions",
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
} else if (command === "setup") {
  entry = join(root, "apps", "bridge", "src", "bin", "cli", "setup.ts");
} else if (command === "connect") {
  entry = join(root, "apps", "bridge", "src", "bin", "cli", "connect.ts");
} else if (command === "phone" && ["add", "reconnect"].includes(argument)) {
  entry = join(root, "apps", "bridge", "src", "bin", "cli", "phone.ts");
} else if (command === "status") {
  entry = join(root, "apps", "mcp", "src", "bin", "status.ts");
} else if (command === "reset") {
  entry = join(root, "apps", "bridge", "src", "bin", "cli", "reset.ts");
} else if (command === "cursor" && argument === "repair") {
  entry = join(root, "apps", "mcp", "src", "bin", "authorize.ts");
} else if (command === "mesh" && argument === "connect") {
  entry = join(root, "apps", "bridge", "src", "bin", "cli", "mesh-connect.ts");
} else if (command === "restrictions" && argument === "check") {
  entry = join(root, "apps", "bridge", "src", "bin", "runtime", "restrictions-check.ts");
} else if (command === "internal" && argument === "mesh-mcp") {
  entry = join(root, "apps", "mcp", "src", "mesh", "mesh-stdio.ts");
} else if (command === "internal" && argument === "serve") {
  entry = join(root, "apps", "mcp", "src", "bin", "serve.ts");
} else if (command === "internal" && argument === "authorize") {
  entry = join(root, "apps", "mcp", "src", "bin", "authorize.ts");
} else if (command === "internal" && argument === "monitor") {
  entry = join(root, "apps", "bridge", "src", "bin", "runtime", "monitor.ts");
} else if (command === "internal" && argument === "hook" && [
  "claude", "claude-prompt", "claude-statusline", "codex", "codex-policy", "cursor", "cursor-after", "cursor-mcp",
].includes(commandArgs[1])) {
  const route = commandArgs[1];
  const hookDir = route === "cursor-mcp" ? "runtime" : "hooks";
  const hookEntry = route === "claude-statusline" ? "statusline/claude-statusline-hook.ts" : route === "codex-policy"
    ? "codex-policy-hook.ts"
    : route === "cursor-after"
      ? "cursor-after-shell.ts"
      : route === "cursor-mcp"
        ? "cursor-mcp-hook.ts"
        : `${route}-hook.ts`;
  entry = join(root, "apps", "bridge", "src", "bin", hookDir, hookEntry);
} else {
  process.stderr.write(usage);
  process.exit(1);
}

// Cursor (and LaunchAgents) often spawn with cwd=$HOME. Bare `--import tsx` then
// resolves from home and dies with ERR_MODULE_NOT_FOUND. Pin absolute loaders + cwd.
const requireFromBin = createRequire(join(root,"package.json"));
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
  if (root !== bundledRoot) rollbackRuntime(bundledRoot, updateDirectory, root);
  process.stderr.write(
    "[granttap-mcp] unable to resolve the installed tsx runtime — reinstall granttap-mcp\n",
  );
  process.exit(1);
}

const forwardedArgs = ["connect", "status", "reset", "mesh", "setup", "restrictions", "phone"].includes(command)
  ? (command === "mesh" || command === "restrictions" ? commandArgs.slice(1) : commandArgs)
  : [];
const background = command === "internal" && ["monitor", "serve"].includes(argument);
const child = spawn(
  process.execPath,
  ["--require", preflight, "--import", pathToFileURL(loader).href,
    "--import", pathToFileURL(join(root, "apps", "bridge", "src", "engine", "startup", "activation-entry.ts")).href,
    entry, ...forwardedArgs],
  {
    stdio: background ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    cwd: root,
    env: {
      ...process.env,
      GRANTTAP_PACKAGE_VERSION: runtimeVersion(root),
      NODE_PATH: [join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter),
    },
  },
);

const supervision = background && managed ? superviseRuntime(child, {bundled:bundledRoot, root, directory:updateDirectory}) : undefined;

function stopChild() {
  supervision?.stop();
  try {
    if (process.platform === "win32") child.kill();
    else child.kill("SIGTERM");
  } catch {
    // The child may already have exited.
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, stopChild);
}

child.on("error", (error) => {
  process.stderr.write(`[granttap-mcp] ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  supervision?.onExit(code, signal);
  if (signal && process.platform !== "win32") {
    try { process.kill(process.pid, signal); } catch { process.exit(code ?? 1); }
  } else process.exit(code ?? 1);
});
