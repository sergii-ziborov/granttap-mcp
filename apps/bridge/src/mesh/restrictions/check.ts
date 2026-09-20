import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ProjectRestrictionSet } from "../../../../../packages/protocol/schema";
import { evaluateContent, type RestrictionViolation } from "./evaluate";

const SKIP_DIR = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".build", "DerivedData",
]);

export function checkRepository(
  root: string,
  restrictions: ProjectRestrictionSet,
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
