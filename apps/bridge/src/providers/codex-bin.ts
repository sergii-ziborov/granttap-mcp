/** Resolve the Codex CLI that can resume desktop tasks from a background helper. */
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

/** launchd does not inherit the desktop app's CLI directory on PATH. */
export function resolveCodexBinary(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  applicationsRoot = home === homedir() ? "/Applications" : join(home, "Applications"),
): string {
  const override = env.GRANTTAP_CODEX_BIN ?? env.NODVOX_CODEX_BIN;
  if (override) return override;
  const onPath = executableOnPath("codex", env);
  if (onPath) return onPath;
  for (const app of ["ChatGPT.app", "Codex.app"]) {
    for (const root of [applicationsRoot, join(home, "Applications")]) {
      const candidate = join(root, app, "Contents", "Resources", "codex");
      if (executable(candidate)) return candidate;
    }
  }
  return "codex";
}
