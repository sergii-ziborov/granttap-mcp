import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectRestrictionSet } from "../../../../../packages/protocol/schema";
import { ProjectRestrictionSet as RestrictionSchema } from "../../../../../packages/protocol/schema";
import { configDir } from "../../config/runtime/paths";
import { writePrivateFile } from "../../config/access/write-private";

type StoreFile = { restrictions: ProjectRestrictionSet[] };

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
  root: string,
  projectId: string,
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
