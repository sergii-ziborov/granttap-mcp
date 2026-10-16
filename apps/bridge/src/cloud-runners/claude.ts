import { providerEffortArgs } from "../reply/process/provider-effort";

const REFERENCE = /^(?:cse|session)_[A-Za-z0-9_-]{1,120}$/;
const LINK = /^https:\/\/\S{1,1000}$/;

export type CloudReference = { reference: string; url?: string };

/**
 * `claude --cloud <description>` without a terminal creates the session,
 * prints its id and link, and exits; it never waits for the cloud turn.
 */
export function claudeCloudArgs(input: { prompt: string; branch?: string; title?: string;
  model?: string; effort?: string }): string[] {
  return ["--cloud", input.prompt,
    ...(input.title ? ["--name", input.title.slice(0, 80)] : []),
    ...(input.branch ? ["--ref", input.branch] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...providerEffortArgs("claude", input.effort)];
}

function fromJson(stdout: string): CloudReference | undefined {
  try {
    const value = JSON.parse(stdout.trim()) as { ok?: unknown; session_id?: unknown; url?: unknown };
    if (value.ok !== true || typeof value.session_id !== "string" || !REFERENCE.test(value.session_id)) return undefined;
    return { reference: value.session_id,
      ...(typeof value.url === "string" && LINK.test(value.url) ? { url: value.url } : {}) };
  } catch { return undefined; }
}

/** Only the session id and link the CLI printed; anything else is not a cloud run. */
export function parseClaudeCloud(stdout: string): CloudReference | undefined {
  const json = fromJson(stdout);
  if (json) return json;
  const id = /^Session ID:\s*(\S+)\s*$/m.exec(stdout)?.[1]
    ?? /^Resume with: claude --teleport (\S+)\s*$/m.exec(stdout)?.[1];
  if (!id || !REFERENCE.test(id)) return undefined;
  const url = /^View:\s*(\S+)\s*$/m.exec(stdout)?.[1];
  return { reference: id, ...(url && LINK.test(url) ? { url } : {}) };
}
