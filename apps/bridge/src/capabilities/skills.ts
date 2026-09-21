import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SharedSkill, SkillInfo } from "../../../../packages/protocol/schema";
import { ancestors } from "./descriptors";
import { skillBundleDigest } from "./skill-bundle";

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
  const roots: string[] = [];
  if (cwd) {
    for (const directory of ancestors(cwd)) {
      roots.push(
        join(directory, ".agents", "skills"),
        join(directory, ".claude", "skills"),
        join(directory, ".cursor", "skills"),
      );
    }
  }
  roots.push(
    join(homedir(), ".cursor", "skills-cursor"),
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills"),
  );
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
    const parsed = readSkillFile(path);
    return parsed ? { name: parsed.name, description: parsed.description } : undefined;
  } catch {
    return undefined;
  }
}

/** Project-local SKILL.md rows for a Mesh snapshot. Global home catalogs stay off this list. */
export function projectSharedSkills(
  paths: Array<string | undefined>, endpointId?: string,
): SharedSkill[] {
  const found = new Map<string, SharedSkill>();
  for (const path of paths) {
    if (!path) continue;
    for (const directory of projectDirectories(path)) {
      for (const root of [
        join(directory, ".agents", "skills"),
        join(directory, ".claude", "skills"),
        join(directory, ".cursor", "skills"),
      ]) {
        for (const skill of sharedSkillsIn(root)) {
          if (endpointId) skill.endpointId = endpointId;
          const prior = found.get(skill.name);
          if (!prior) found.set(skill.name, skill);
          else if (prior.state !== "conflict" && prior.digest !== skill.digest) {
            found.set(skill.name, {
              name: skill.name, endpointId, state: "conflict",
              source: "multiple project workspaces",
            });
          }
        }
      }
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 64);
}

function projectDirectories(path: string): string[] {
  const directories = ancestors(path);
  const repository = directories.findIndex((directory) => existsSync(join(directory, ".git")));
  // A missing Git boundary is not permission to walk into home Skills.
  return repository < 0 ? directories.slice(0, 1) : directories.slice(0, repository + 1);
}

function sharedSkillsIn(root: string): SharedSkill[] {
  let entries: string[];
  try {
    // A repository-local catalog must not redirect into a home or unrelated
    // Project through a symlinked .agents/.claude/.cursor directory.
    if (!lstatSync(dirname(root)).isDirectory() || !lstatSync(root).isDirectory()) return [];
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const skills: SharedSkill[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const directory = join(root, name);
    try {
      if (!statSync(directory).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = readSkillFile(join(directory, "SKILL.md"));
    if (!skill) continue;
    const digest = skillBundleDigest(join(directory, "SKILL.md"));
    skills.push({
      name: skill.name,
      description: clipSkillText(skill.description, 500),
      version: clipSkillText(skill.version, 64),
      digest,
      source: "project-workspace",
      state: digest ? "discovered" : "unknown",
    });
  }
  return skills;
}

function clipSkillText(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function readSkillFile(path: string): {
  name: string;
  description?: string;
  version?: string;
} | undefined {
  try {
    const body = readFileSync(path, "utf8");
    if (!body.startsWith("---")) return undefined;
    const end = body.indexOf("\n---", 3);
    if (end < 0) return undefined;
    const header = body.slice(3, end);
    const name = header.match(/^name:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    if (!name) return undefined;
    const description = header.match(/^description:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    const version = header.match(/^version:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    return {
      name: name.slice(0, 160),
      description: clipSkillText(description, 500),
      version: clipSkillText(version, 64),
    };
  } catch {
    return undefined;
  }
}
