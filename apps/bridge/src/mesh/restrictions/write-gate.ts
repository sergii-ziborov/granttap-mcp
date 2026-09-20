import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { evaluateContent, type RestrictionViolation } from "./evaluate";
import { loadRestrictions } from "./store";

export function writeCandidate(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  cwd?: string,
): { path: string; content: string } | undefined {
  if (!toolInput) return undefined;
  const tool = (toolName ?? "").toLowerCase();
  if (!["write", "edit", "multiedit", "notebookedit"].includes(tool)) return undefined;
  const rawPath = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path;
  if (typeof rawPath !== "string" || !rawPath) return undefined;
  const filePath = rawPath;
  if (typeof toolInput.content === "string") {
    return { path: filePath, content: toolInput.content };
  }
  const disk = readExisting(filePath, cwd);
  if (typeof toolInput.old_string === "string" && typeof toolInput.new_string === "string") {
    return { path: filePath, content: disk.split(toolInput.old_string).join(toolInput.new_string) };
  }
  if (Array.isArray(toolInput.edits)) {
    let next = disk;
    for (const edit of toolInput.edits) {
      if (!edit || typeof edit !== "object") continue;
      const row = edit as { old_string?: unknown; new_string?: unknown };
      if (typeof row.old_string === "string" && typeof row.new_string === "string") {
        next = next.split(row.old_string).join(row.new_string);
      }
    }
    return { path: filePath, content: next };
  }
  return disk ? { path: filePath, content: disk } : undefined;
}

function readExisting(filePath: string, cwd?: string): string {
  const absolute = filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)
    ? filePath
    : join(cwd ?? "", filePath);
  try {
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return "";
    if (statSync(absolute).size > 1_000_000) return "";
    return readFileSync(absolute, "utf8");
  } catch {
    return "";
  }
}

export function evaluateWriteRestrictions(input: {
  projectId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  cwd?: string;
}): RestrictionViolation | undefined {
  if (!input.projectId) return undefined;
  const stored = loadRestrictions(input.projectId);
  if (!stored || stored.rules.length === 0) return undefined;
  const candidate = writeCandidate(input.toolName, input.toolInput, input.cwd);
  if (!candidate) return undefined;
  return evaluateContent(stored.rules, candidate.path, candidate.content);
}
