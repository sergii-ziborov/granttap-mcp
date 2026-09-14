import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInfo } from "../../../../packages/protocol/schema";
import { ancestors } from "./descriptors";

/** Skills available globally and along the task's repository path. */
export function workspaceSkills(cwd: string | undefined): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
  for (const root of skillRoots(cwd)) {
    for (const skill of skillsIn(root)) {
      if (!found.has(skill.name)) found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The source file behind a named skill, in the same precedence as the catalog. */
export function skillDefinitionPath(name: string, cwd: string | undefined): string | undefined {
  for (const root of skillRoots(cwd)) {
    let entries: string[];
    try { entries = readdirSync(root); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const path = join(root, entry, "SKILL.md");
      if (frontmatter(path)?.name === name) return path;
    }
  }
  return undefined;
}

function skillRoots(cwd: string | undefined): string[] {
  const roots = [
    join(homedir(), ".cursor", "skills-cursor"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills"),
  ];
  if (cwd) {
    for (const directory of ancestors(cwd)) {
      roots.push(
        join(directory, ".agents", "skills"),
        join(directory, ".claude", "skills"),
        join(directory, ".cursor", "skills"),
      );
    }
  }
  return roots;
}

function skillsIn(root: string): SkillInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const directory = join(root, name);
    try {
      if (!statSync(directory).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = frontmatter(join(directory, "SKILL.md"));
    if (skill) skills.push(skill);
  }
  return skills;
}

function frontmatter(path: string): SkillInfo | undefined {
  try {
    const body = readFileSync(path, "utf8");
    if (!body.startsWith("---")) return undefined;
    const end = body.indexOf("\n---", 3);
    if (end < 0) return undefined;
    const header = body.slice(3, end);
    const name = header.match(/^name:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    if (!name) return undefined;
    const description = header.match(/^description:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    return { name, description };
  } catch {
    return undefined;
  }
}
