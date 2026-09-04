/**
 * Files an agent was seen writing, per chat, for a short while.
 *
 * Nothing here reaches the wire. The transcript scan notes every edit tool
 * call it passes; the Mesh turns the recent ones into intent claims so two
 * agents heading for the same file or module are warned before the merge
 * says so. Paths are kept as the agent gave them and made repository-relative
 * only when a claim is derived, because that is the only place the root is
 * known.
 */
export type ObservedWrite = { path: string; at: number };

/** Ten minutes: long enough to cover a working stretch, short enough to expire. */
export const OBSERVED_WRITE_TTL_MS = 10 * 60_000;
const MAX_PATHS_PER_SESSION = 64;
const MAX_SESSIONS = 256;

const writes = new Map<string, Map<string, number>>();

/** Edit tools across providers, and where each keeps the path it writes. */
export function writtenPaths(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const name = toolName.toLowerCase();
  const direct = ["file_path", "notebook_path", "path", "target_file", "filePath"]
    .map((key) => record[key]).find((value): value is string => typeof value === "string");
  if (/^(write|edit|multiedit|notebookedit|edit_file|write_file|create_file|delete_file|search_replace|str_replace_editor|str_replace_based_edit_tool)$/.test(name)) {
    const nested = Array.isArray(record.edits)
      ? (record.edits as unknown[]).flatMap((edit) =>
        edit && typeof edit === "object" && typeof (edit as Record<string, unknown>).file_path === "string"
          ? [(edit as Record<string, unknown>).file_path as string] : [])
      : [];
    return [...(direct ? [direct] : []), ...nested];
  }
  if (name === "apply_patch" || name === "functions.apply_patch") {
    const patch = typeof record.patch === "string" ? record.patch
      : typeof record.input === "string" ? record.input : "";
    return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
  }
  return [];
}

export function recordObservedWrite(sessionId: string, path: string, at: number): void {
  let paths = writes.get(sessionId);
  if (!paths) {
    if (writes.size >= MAX_SESSIONS) {
      const oldest = writes.keys().next().value as string | undefined;
      if (oldest) writes.delete(oldest);
    }
    paths = new Map();
    writes.set(sessionId, paths);
  }
  if ((paths.get(path) ?? 0) >= at) return;
  paths.delete(path);
  paths.set(path, at);
  while (paths.size > MAX_PATHS_PER_SESSION) {
    const oldest = paths.keys().next().value as string | undefined;
    if (oldest) paths.delete(oldest);
  }
}

/** Writes still inside the window, newest last. */
export function recentObservedWrites(sessionId: string, now: number): ObservedWrite[] {
  const paths = writes.get(sessionId);
  if (!paths) return [];
  return [...paths.entries()]
    .filter(([, at]) => now - at <= OBSERVED_WRITE_TTL_MS)
    .map(([path, at]) => ({ path, at }));
}

export function clearObservedWrites(): void {
  writes.clear();
}
