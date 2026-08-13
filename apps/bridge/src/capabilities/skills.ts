import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInfo } from "../../../../packages/protocol/schema";
import { ancestors } from "./descriptors";

/** Skills available globally and along the task's repository path. */
export function workspaceSkills(cwd: string | undefined): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
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
  for (const root of roots) {
    for (const skill of skillsIn(root)) {
      if (!found.has(skill.name)) found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
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
