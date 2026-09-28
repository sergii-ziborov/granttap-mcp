import { safeParse } from "../sessions/support/common";
import { sensitivePath } from "../sessions/support/edit-stats";
import { statsFromPatchText } from "../sessions/support/edit-stats";
import { redactSecrets } from "../sessions/telemetry/command-preview";

export type RecordedFileChange = { path: string; linesAdded: number; linesRemoved: number; diff: string; diffTruncated?: boolean };

export function nativeChanges(item: any): RecordedFileChange[] {
  if (item?.type !== "FileChange" || item.status !== "completed" || !item.changes) return [];
  return Object.entries(item.changes).flatMap(([path, raw]) => {
    if (sensitivePath(path)) return [];
    const change = raw as { type?: string; content?: string; unified_diff?: string };
    const content = typeof change.content === "string" ? change.content : "";
    const contentLines = content ? content.replace(/\n$/, "").split("\n") : [];
    const diff = typeof change.unified_diff === "string" ? change.unified_diff
      : contentLines.map((line) => (change.type === "delete" ? "-" : "+") + line).join("\n");
    const stats = statsFromPatchText(diff) ?? { linesAdded: 0, linesRemoved: 0 };
    const clean = redactSecrets(diff);
    return [{ path: path.slice(0, 2048), ...stats, diff: clean.slice(0, 16_384),
      ...(clean.length > 16_384 ? { diffTruncated: true } : {}) }];
  });
}

/** Decode a literal passed to tools.apply_patch; never evaluate orchestrator source. */
function literalPatches(source: string): string[] {
  const patches: string[] = [];
  for (const match of source.matchAll(/\btools\.apply_patch\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs)) {
    const literal = match[1]!;
    if (literal.startsWith('"')) { try { patches.push(JSON.parse(literal)); } catch { /* invalid literal */ } }
    else if (!literal.includes("${")) {
      patches.push(literal.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|n|r|t|\\|'|"|`)/g, (_, char: string) =>
        char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t"
          : char.startsWith("u") ? String.fromCharCode(parseInt(char.slice(1), 16)) : char));
    }
  }
  return patches;
}

function patchFiles(patch: string): RecordedFileChange[] {
  const files: RecordedFileChange[] = [];
  let current: RecordedFileChange | undefined;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = sensitivePath(header[1]) ? undefined : { path: header[1]!.slice(0, 2048), linesAdded: 0, linesRemoved: 0, diff: "" };
      if (current) files.push(current);
    } else if (current && !line.startsWith("***")) {
      if (line.startsWith("+")) current.linesAdded++;
      if (line.startsWith("-")) current.linesRemoved++;
      const source = line + "\n";
      const remaining = 16_384 - current.diff.length;
      current.diff += source.slice(0, Math.max(0, remaining));
      if (source.length > remaining) current.diffTruncated = true;
    }
  }
  return files.slice(0, 64).map((file) => {
    const clean = redactSecrets(file.diff);
    return { ...file, diff: clean.slice(0, 16_384),
      ...(clean.length > 16_384 ? { diffTruncated: true } : {}) };
  });
}

/** Only patches with an explicit successful result become reported changes. */
export function recordedFileChanges(lines: readonly string[]): Map<string, RecordedFileChange[]> {
  const pending = new Map<string, string[]>();
  const result = new Map<string, RecordedFileChange[]>();
  const native = new Map<string, RecordedFileChange[]>();
  for (const line of lines) {
    const row = safeParse(line);
    const payload = row?.payload;
    if (row?.type === "event_msg" && payload?.type === "item_completed") {
      const changes = nativeChanges(payload.item);
      if (changes.length && typeof payload.item?.id === "string") native.set(payload.item.id, changes.slice(0, 64));
    }
    if (row?.type !== "response_item" || !payload?.call_id) continue;
    if (["function_call", "custom_tool_call"].includes(payload.type)) {
      let input = payload.input ?? payload.arguments;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* raw tool source */ } }
      const name = String(payload.name ?? "").split(/[.:/]/).at(-1);
      const patches = name === "apply_patch" ? [typeof input === "string" ? input : input?.patch ?? input?.input ?? ""]
        : typeof input === "string" ? literalPatches(input) : [];
      if (patches.length) pending.set(payload.call_id, patches);
    } else if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const patches = pending.get(payload.call_id);
      const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
      if (patches && /Success\. Updated the following files/.test(output) && !/Failed to apply|isError.*true/.test(output)) {
        result.set(payload.call_id, patches.flatMap(patchFiles).slice(0, 64));
      }
      pending.delete(payload.call_id);
    }
  }
  return native.size ? native : result;
}
