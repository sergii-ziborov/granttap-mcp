import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Cursor Agent CLI is often installed under Cursor's Application Support tree
 * without a PATH entry. Resolve an absolute executable for messaging resume.
 */
export function resolveCursorAgentBin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.GRANTTAP_CURSOR_AGENT_BIN?.trim();
  if (configured) return configured;
  for (const candidate of knownCursorAgentPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  // `which` can itself fail to spawn, and spawnSync then reports null streams.
  // Resolving a binary must never be able to take down `granttap status`.
  const which = spawnSync("which", ["cursor-agent"], { encoding: "utf8" });
  const found = which.stdout?.trim().split("\n")[0]?.trim();
  return found || "cursor-agent";
}

function knownCursorAgentPaths(): string[] {
  const home = homedir();
  const worker = join(
    home,
    "Library/Application Support/Cursor/User/globalStorage",
    "anysphere.cursor-agent-worker/agent-cli",
  );
  const versionsRoot = join(worker, ".local/share/cursor-agent/versions");
  const versioned: string[] = [];
  try {
    for (const name of readdirSync(versionsRoot).sort().reverse()) {
      versioned.push(join(versionsRoot, name, "cursor-agent"));
    }
  } catch {
    // No Cursor Agent versions directory yet.
  }
  return [
    join(home, ".local/bin/cursor-agent"),
    join(worker, ".local/bin/cursor-agent"),
    ...versioned,
  ];
}
