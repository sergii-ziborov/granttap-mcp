/**
 * Auto-registration of the agent hooks — the part that used to be "copy this
 * snippet into your config yourself".
 *
 *   Claude Code  ~/.claude/settings.json   hooks.PreToolUse
 *   Codex        ~/.codex/config.toml      [features] hooks + [[hooks.PermissionRequest]]
 *
 * Rules: back the file up once before first touching it, never register twice
 * (any existing "granttap" hook counts), and if a TOML merge would be ambiguous,
 * say so instead of corrupting the file.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The stable command agents will call. */
export function hookCommand(agent: "claude" | "codex"): string {
  return `node "${join(repoRoot, "bin", "granttap-mcp.mjs")}" hook ${agent}`;
}

export type InstallResult = { status: "installed" | "already" | "manual"; detail: string };

function backupOnce(path: string): void {
  const bak = path + ".bak-granttap";
  if (existsSync(path) && !existsSync(bak)) copyFileSync(path, bak);
}

// ---------------------------------------------------------------- Claude Code

export function installClaudeHook(): InstallResult {
  const dir =
    process.env.GRANTTAP_CLAUDE_DIR ??
    process.env.NODVOX_CLAUDE_DIR ??
    join(homedir(), ".claude");
  const path = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let settings: any = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { status: "manual", detail: `${path} — не парсится как JSON, не трогаю. Добавь hook вручную.` };
    }
  }

  const entries: any[] = (((settings.hooks ??= {}).PreToolUse ??= []) as any[]);
  const hooks = entries.flatMap((entry) => entry?.hooks ?? []);
  const present = hooks.some(
    (hook: any) => typeof hook?.command === "string" && hook.command.includes("granttap"),
  );
  if (present) return { status: "already", detail: path };

  const legacy = hooks.find(
    (hook: any) =>
      typeof hook?.command === "string" &&
      (hook.command.includes("bin/nodvox.mjs") || /\bnpx\s+(?:-y\s+)?nodvox\b/.test(hook.command)),
  );
  if (legacy) {
    backupOnce(path);
    legacy.command = hookCommand("claude");
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    return { status: "installed", detail: `${path}, обновлён Nodvox → GrantTap` };
  }

  backupOnce(path);
  entries.push({
    matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
    hooks: [{ type: "command", command: hookCommand("claude"), timeout: 120 }],
  });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return { status: "installed", detail: path };
}

// --------------------------------------------------------------------- Codex

export function installCodexHook(): InstallResult {
  const dir =
    process.env.GRANTTAP_CODEX_DIR ??
    process.env.NODVOX_CODEX_DIR ??
    join(homedir(), ".codex");
  const path = join(dir, "config.toml");
  mkdirSync(dir, { recursive: true });

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes("granttap")) return { status: "already", detail: path };
  if (existing.includes("bin/nodvox.mjs") || /\bnpx\s+(?:-y\s+)?nodvox\b/.test(existing)) {
    const updated = existing
      .replace(
        /^command\s*=\s*'[^']*(?:bin\/nodvox\.mjs|\bnpx\s+(?:-y\s+)?nodvox\b)[^']*'$/gm,
        `command = '${hookCommand("codex")}'`,
      )
      .replace(/^# nodvox —/gm, "# GrantTap —");
    backupOnce(path);
    writeFileSync(path, updated);
    return { status: "installed", detail: `${path}, обновлён Nodvox → GrantTap` };
  }

  const hookBlock = [
    "",
    "# granttap — approvals from your phone/watch",
    "[[hooks.PermissionRequest]]",
    'matcher = ".*"',
    "[[hooks.PermissionRequest.hooks]]",
    'type = "command"',
    `command = '${hookCommand("codex")}'`,
    "timeout = 120",
    "",
  ].join("\n");

  const hasFeatures = /^\s*\[features\]/m.test(existing);
  const hasHooksFlag = /^\s*hooks\s*=\s*true/m.test(existing);

  backupOnce(path);
  if (!hasFeatures) {
    writeFileSync(path, existing + "\n[features]\nhooks = true\n" + hookBlock);
    return { status: "installed", detail: path };
  }
  if (hasHooksFlag) {
    writeFileSync(path, existing + hookBlock);
    return { status: "installed", detail: path };
  }
  // [features] exists without hooks=true — appending a second [features] table
  // would be invalid TOML, so append the hook and ask for the one-line edit.
  writeFileSync(path, existing + hookBlock);
  return {
    status: "manual",
    detail: `${path}: hook добавлен, но в существующей секции [features] нужно вручную дописать «hooks = true».`,
  };
}
