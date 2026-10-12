import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AutoAcceptLevel } from "../../../../packages/protocol/schema";
import { configDir } from "../config/runtime/paths";
import { writePrivateFile } from "../config/access/write-private";

const Grant = z.object({ sessionId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(128), revision: z.number().int().nonnegative(),
  level: AutoAcceptLevel });
const File = z.object({ version: z.literal(1), grants: z.array(Grant).max(256) }).strict();
type Grant = z.infer<typeof Grant>;
const path = () => join(configDir(), "task-automation.json");

function read(): Grant[] {
  try { return File.parse(JSON.parse(readFileSync(path(), "utf8"))).grants; }
  catch { return []; }
}

/** Only a fresh authenticated controller command calls this mutation. */
export function grantTaskAutomation(sessionId: string, projectId: string,
  revision: number, level: z.infer<typeof AutoAcceptLevel> | null): void {
  const grants = read().filter(item => item.sessionId !== sessionId);
  if (level && level !== "ask") grants.push(Grant.parse({ sessionId, projectId, revision, level }));
  writePrivateFile(path(), JSON.stringify({ version: 1, grants: grants.slice(-256) }));
}

export function revokeTaskAutomation(sessionId: string): void {
  writePrivateFile(path(), JSON.stringify({ version: 1, grants: read().filter(item => item.sessionId !== sessionId) }));
}

export function taskAutomationProject(sessionId: string | null | undefined): string | undefined {
  return read().find(item => item.sessionId === sessionId)?.projectId;
}

export function taskAutomationLevel(sessionId: string | undefined, projectId: string,
  revision: number): z.infer<typeof AutoAcceptLevel> | undefined {
  return read().find(item => item.sessionId === sessionId && item.projectId === projectId
    && item.revision === revision)?.level;
}

/** A human chat exception can answer ASK; it never overrides a DENY or an unavailable engine. */
export function permitsProjectAskAutomation(decision: {
  effect: string; projectId?: string; policy_revision?: number; engineEvaluated: boolean;
}, sessionId: string | undefined): boolean {
  return decision.effect === "ask" && decision.engineEvaluated && !!decision.projectId
    && decision.policy_revision != null
    && taskAutomationLevel(sessionId, decision.projectId, decision.policy_revision) != null;
}
