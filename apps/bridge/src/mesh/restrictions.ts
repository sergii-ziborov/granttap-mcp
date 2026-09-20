import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type {
  ProjectRestrictionRule,
  ProjectRestrictionSet,
} from "../../../../packages/protocol/schema";
import { ProjectRestrictionSet as RestrictionSchema } from "../../../../packages/protocol/schema";
import { configDir } from "../config/paths";
import { writePrivateFile } from "../config/write-private";

export type RestrictionViolation = {
  ruleId: string;
  kind: ProjectRestrictionRule["kind"];
  effect: "ask" | "deny";
  path: string;
  reason: string;
};

type StoreFile = { restrictions: ProjectRestrictionSet[] };

const SKIP_DIR = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".build", "DerivedData",
]);

export function restrictionsPath(): string {
  return join(configDir(), "project-restrictions.json");
}

export function repoRestrictionsPath(root: string): string {
  return join(root, ".granttap", "restrictions.json");
}

function loadAll(): ProjectRestrictionSet[] {
  try {
    const raw = JSON.parse(readFileSync(restrictionsPath(), "utf8")) as StoreFile;
    return Array.isArray(raw.restrictions)
      ? raw.restrictions.flatMap((item) => {
        const parsed = RestrictionSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
      : [];
  } catch {
    return [];
  }
}

function saveAll(restrictions: ProjectRestrictionSet[]): void {
  writePrivateFile(restrictionsPath(), `${JSON.stringify({ restrictions }, null, 2)}\n`);
}

export function loadRestrictions(projectId: string): ProjectRestrictionSet | undefined {
  return loadAll().find((item) => item.projectId === projectId);
}

export function rememberRestrictions(
  projectId: string,
  restrictions: ProjectRestrictionSet | undefined,
  repositoryRoot?: string,
): ProjectRestrictionSet | undefined {
  const others = loadAll().filter((item) => item.projectId !== projectId);
  if (!restrictions) {
    saveAll(others);
    return undefined;
  }
  let stored: ProjectRestrictionSet = { ...restrictions, projectId };
  if (stored.scope === "sync_from_repo" && repositoryRoot) {
    stored = readRepoRestrictions(repositoryRoot, projectId) ?? { ...stored, source: "repo" };
  }
  if (stored.scope === "project_and_repo" && repositoryRoot) {
    writeRepoRestrictions(repositoryRoot, stored);
  }
  saveAll([...others, stored]);
  return stored;
}

export function readRepoRestrictions(
  root: string, projectId: string,
): ProjectRestrictionSet | undefined {
  try {
    const raw = JSON.parse(readFileSync(repoRestrictionsPath(root), "utf8")) as {
      revision?: unknown;
      scope?: unknown;
      repositoryId?: unknown;
      rules?: unknown;
    };
    const parsed = RestrictionSchema.safeParse({
      projectId,
      revision: raw.revision,
      scope: raw.scope,
      repositoryId: raw.repositoryId,
      rules: raw.rules,
      source: "repo",
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeRepoRestrictions(root: string, restrictions: ProjectRestrictionSet): void {
  const path = repoRestrictionsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    projectId: restrictions.projectId,
    revision: restrictions.revision,
    scope: restrictions.scope,
    repositoryId: restrictions.repositoryId,
    rules: restrictions.rules,
    source: restrictions.source,
  }, null, 2)}\n`, { mode: 0o644 });
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

/** Brace-depth bodies that start on a function/func/def/fn line. */
export function functionLineCounts(source: string): number[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const counts: number[] = [];
  let depth = 0;
  let start = -1;
  const starts = /^\s*(export\s+)?(async\s+)?(public\s+|private\s+|internal\s+|fileprivate\s+|pub\s+)?(static\s+)?(function|func|fn|def)\b/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (start < 0 && starts.test(line)) start = index;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (start >= 0) depth += opens - closes;
    if (start >= 0 && depth <= 0 && opens + closes > 0) {
      counts.push(index - start + 1);
      start = -1;
      depth = 0;
    }
  }
  return counts;
}

export function pathMatches(filePath: string, glob: string): boolean {
  const normalized = filePath.split(sep).join("/");
  const pattern = glob.split(sep).join("/");
  if (pattern === "**" || pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(normalized)
    || new RegExp(`(?:^|/)${escaped}$`).test(normalized);
}

export function ruleApplies(rule: ProjectRestrictionRule, filePath: string): boolean {
  const paths = rule.paths ?? [];
  if (paths.length === 0) return true;
  return paths.some((glob) => pathMatches(filePath, glob));
}

export function evaluateContent(
  rules: ProjectRestrictionRule[],
  filePath: string,
  content: string,
): RestrictionViolation | undefined {
  const lines = countLines(content);
  const bytes = Buffer.byteLength(content);
  const functions = functionLineCounts(content);
  for (const rule of rules) {
    if (!ruleApplies(rule, filePath)) continue;
    if (rule.kind === "max_file_lines" && rule.limit != null && lines > rule.limit) {
      return violation(rule, filePath, `${lines} lines (limit ${rule.limit})`);
    }
    if (rule.kind === "max_file_bytes" && rule.limit != null && bytes > rule.limit) {
      return violation(rule, filePath, `${bytes} bytes (limit ${rule.limit})`);
    }
    if (rule.kind === "max_function_lines" && rule.limit != null) {
      const worst = Math.max(0, ...functions);
      if (worst > rule.limit) {
        return violation(rule, filePath, `a function is ${worst} lines (limit ${rule.limit})`);
      }
    }
  }
  return undefined;
}

function violation(
  rule: ProjectRestrictionRule, filePath: string, detail: string,
): RestrictionViolation {
  const name = rule.name ?? rule.kind.replace(/_/g, " ");
  return {
    ruleId: rule.ruleId,
    kind: rule.kind,
    effect: rule.effect,
    path: filePath,
    reason: `${name}: ${filePath} ${detail}`,
  };
}

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

export function checkRepository(
  root: string, restrictions: ProjectRestrictionSet,
): RestrictionViolation[] {
  const files = listSourceFiles(root);
  const found: RestrictionViolation[] = [];
  for (const file of files) {
    let content = "";
    try {
      if (statSync(file).size > 1_000_000) continue;
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relativePath = relative(root, file).split(sep).join("/");
    const hit = evaluateContent(restrictions.rules, relativePath, content);
    if (hit) found.push(hit);
  }
  return found;
}

function listSourceFiles(root: string, prefix = ""): string[] {
  const directory = prefix ? join(root, prefix) : root;
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (SKIP_DIR.has(name) || name.startsWith(".")) continue;
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const full = join(root, relativePath);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(root, relativePath));
    } else if (stat.isFile() && isTextish(name)) {
      out.push(full);
    }
  }
  return out;
}

function isTextish(name: string): boolean {
  return /\.(ts|tsx|js|jsx|swift|py|rs|go|rb|kt|java|m|mm|cs|c|cc|cpp|h|hpp|md|json|yml|yaml)$/i
    .test(name);
}

export function restrictionSummary(restrictions: ProjectRestrictionSet | undefined): string {
  if (!restrictions || restrictions.rules.length === 0) return "No restrictions";
  const count = restrictions.rules.length;
  const scope = restrictions.scope === "sync_from_repo"
    ? "from the repository"
    : restrictions.scope === "project_and_repo"
      ? "Project and repository"
      : "this Project";
  return `${count} rule${count === 1 ? "" : "s"} · ${scope}`;
}
