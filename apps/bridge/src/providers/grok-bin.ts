/** Resolve the Grok Build CLI the same way for its catalog, its turns and its status. */
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executableOnPath } from "./claude-bin";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Grok's own home: `GRANTTAP_GROK_DIR` for tests and relocated installs, else ~/.grok. */
export function grokHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.GRANTTAP_GROK_DIR ?? join(home, ".grok");
}

/**
 * launchd does not inherit an interactive shell's PATH, and Grok's installer
 * keeps its binary under ~/.grok/bin. An explicit override still wins.
 */
export function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.GRANTTAP_GROK_BIN) return env.GRANTTAP_GROK_BIN;
  const onPath = executableOnPath("grok", env);
  if (onPath) return onPath;
  const installed = join(grokHome(env, home), "bin", "grok");
  return executable(installed) ? installed : "grok";
}
