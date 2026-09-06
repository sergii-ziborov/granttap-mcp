/**
 * Projects this computer has seen governed.
 *
 * The engine holds the policies; the hook only asks it. When the engine could
 * not answer, the hook fell back to legacy behaviour, which reads as allowed,
 * so an engine that was down, or merely slow, switched a governed Project's
 * rules off. What is remembered here is only that a Project has a policy and
 * which revision: enough to fail closed, to a question for the person,
 * instead of open.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "../config/paths";

const MAX_PROJECTS = 256;

const GovernedFile = z.object({
  version: z.literal(1),
  projects: z.record(z.object({
    revision: z.number().int().nonnegative(),
    at: z.number().nonnegative(),
  })),
}).strict();
type GovernedFile = z.infer<typeof GovernedFile>;

function filePath(): string {
  return join(configDir(), "governed-projects.json");
}

function read(): GovernedFile {
  try {
    const parsed = GovernedFile.safeParse(JSON.parse(readFileSync(filePath(), "utf8")));
    return parsed.success ? parsed.data : { version: 1, projects: {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

/** Remember that a Project has a policy. Revision 0 means it has none, and it is forgotten. */
export function rememberGovernedProject(projectId: string, revision: number, now = Date.now()): void {
  try {
    const file = read();
    if (file.projects[projectId]?.revision === revision) return;
    if (revision > 0) file.projects[projectId] = { revision, at: now };
    else delete file.projects[projectId];
    const entries = Object.entries(file.projects)
      .sort((left, right) => right[1].at - left[1].at)
      .slice(0, MAX_PROJECTS);
    mkdirSync(configDir(), { recursive: true });
    const path = filePath();
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, projects: Object.fromEntries(entries) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
  } catch {
    // Best effort: a memory that could not be written only means the old fallback.
  }
}

/** The policy revision this Project was last seen with, or nothing when it has none. */
export function governedRevision(projectId: string): number | undefined {
  return read().projects[projectId]?.revision;
}
