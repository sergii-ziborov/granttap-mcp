import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import type { SessionInfo } from "../../../../packages/protocol/schema";
import { claudeLogPathBySession } from "./scan/claude/shared";
import { codexLogPathBySession } from "./scan/codex/shared";
import { claudeProjectsRoot, codexSessionsRoot } from "./support/common";

export function nativeTranscriptRoots(): { claude: string; codex: string } {
  return { claude: claudeProjectsRoot(), codex: codexSessionsRoot() };
}

/** Native paths come only from discovery; a phone never supplies one. */
export function nativeTranscriptSource(session: Pick<SessionInfo, 'agent' | 'sessionId'>): string | undefined {
  if (session.agent === "claude") return claudeLogPathBySession.get(session.sessionId);
  if (session.agent === "codex") return codexLogPathBySession.get(session.sessionId);
  return undefined;
}

/** Restore an owned native source without walking every provider's logs. */
export function restoreNativeTranscriptSource(session: SessionInfo, path: string): boolean {
  if (!["claude", "codex"].includes(session.agent)
    || !/^[a-zA-Z0-9-]{1,128}$/.test(session.sessionId)) return false;
  const name = basename(path);
  if (session.agent === "claude" ? name !== `${session.sessionId}.jsonl`
    : !name.startsWith("rollout-") || !name.endsWith(`-${session.sessionId}.jsonl`)) return false;
  try {
    if (!lstatSync(path).isFile()) return false;
    const root = session.agent === "claude" ? claudeProjectsRoot() : codexSessionsRoot();
    const inside = relative(realpathSync(root), realpathSync(path));
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return false;
    const index = session.agent === "claude" ? claudeLogPathBySession : codexLogPathBySession;
    index.set(session.sessionId, path);
    return true;
  } catch { return false; }
}
