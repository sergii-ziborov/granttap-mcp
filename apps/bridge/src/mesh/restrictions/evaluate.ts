import { sep } from "node:path";
import type { ProjectRestrictionRule } from "../../../../../packages/protocol/schema";

export type RestrictionViolation = {
  ruleId: string;
  kind: ProjectRestrictionRule["kind"];
  effect: "ask" | "deny";
  path: string;
  reason: string;
};

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
  rule: ProjectRestrictionRule,
  filePath: string,
  detail: string,
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
