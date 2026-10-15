import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { configDir } from "../config/runtime/paths";
import { writePrivateFile } from "../config/access/write-private";
import { ProviderAccountUsage, type ProviderAccountUsage as Usage } from "../../../../packages/protocol/schema";

const previousPath = () => join(configDir(), "claude-statusline-previous.json");
const reportPath = () => join(configDir(), "claude-account-usage.json");

export function projectClaudeUsage(input: any, now = Date.now()): Usage | undefined {
  const windows = ([["five_hour", "primary", 300], ["seven_day", "secondary", 10_080]] as const)
    .flatMap(([key, id, duration]) => {
      const value = input?.rate_limits?.[key];
      if (!Number.isFinite(value?.used_percentage) || value.used_percentage < 0 || value.used_percentage > 100
        || !Number.isFinite(value?.resets_at) || value.resets_at * 1_000 <= now) return [];
      return [{ id: id as "primary" | "secondary", usedPercent: value.used_percentage,
        windowMinutes: Number(duration), resetsAt: value.resets_at * 1_000 }];
    });
  return windows.length ? { provider: "claude", limitId: "claude", observedAt: now, windows } : undefined;
}

export function readClaudeUsage(now = Date.now()): Usage[] {
  try {
    const text = readFileSync(reportPath(), "utf8");
    if (text.length > 4_096) return [];
    const value = ProviderAccountUsage.parse(JSON.parse(text));
    return now - value.observedAt <= 5 * 60_000 && value.observedAt <= now + 60_000 ? [value] : [];
  } catch { return []; }
}

/** Keep the person's existing status renderer and its options; never touch approval policy. */
export function ensureClaudeUsageStatusLine(settings: any, command: string): boolean {
  if (settings.statusLine?.command === command) return false;
  if (typeof settings.statusLine?.command === "string" && settings.statusLine.command.includes("internal hook claude-statusline")) {
    settings.statusLine.command = command;
    return true;
  }
  if (settings.statusLine && settings.statusLine.type !== "command") return false;
  writePrivateFile(previousPath(), JSON.stringify(settings.statusLine ?? null));
  settings.statusLine = { ...settings.statusLine, type: "command", command };
  return true;
}

export async function runClaudeStatusLine(raw: string): Promise<void> {
  try {
    const input = JSON.parse(raw);
    const usage = projectClaudeUsage(input);
    if (usage) writePrivateFile(reportPath(), JSON.stringify(usage));
    const previous = existsSync(previousPath()) ? JSON.parse(readFileSync(previousPath(), "utf8")) : null;
    if (typeof previous?.command !== "string" || !previous.command.trim()) {
      if (usage) process.stdout.write(usage.windows.map(w => `${w.windowMinutes === 300 ? "5h" : "7d"} ${w.usedPercent}%`).join(" · "));
      return;
    }
    await new Promise<void>(resolve => {
      const child = spawn(previous.command, { shell: true, stdio: ["pipe", "inherit", "ignore"], timeout: 3_000 });
      child.stdin.on("error", () => undefined);
      child.on("error", () => resolve());
      child.on("close", () => resolve());
      child.stdin.end(raw);
    });
  } catch { /* A status renderer must never interfere with a provider conversation. */ }
}
