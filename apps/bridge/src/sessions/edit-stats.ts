/**
 * How much a file tool changed, the way git says it: lines added, lines
 * removed.
 *
 * A Write or an Edit row read as a path and nothing else; the size of the
 * change is what a person wants to know before opening it. The provider's own
 * patch is the exact answer when the transcript carries one; the tool's input
 * is the honest estimate when it does not — a created file is all additions,
 * an edit is its old lines out and its new lines in.
 */
export type EditStats = { linesAdded: number; linesRemoved: number };

function lineCount(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  const lines = value.split("\n");
  return value.endsWith("\n") ? lines.length - 1 : lines.length;
}

/** From a structured patch: hunks whose `lines` carry `+`/`-` prefixes. */
export function statsFromPatch(patch: unknown): EditStats | undefined {
  if (!Array.isArray(patch)) return undefined;
  let linesAdded = 0;
  let linesRemoved = 0;
  let seen = false;
  for (const hunk of patch) {
    const lines = (hunk as { lines?: unknown } | null)?.lines;
    if (!Array.isArray(lines)) continue;
    seen = true;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) linesAdded += 1;
      else if (line.startsWith("-")) linesRemoved += 1;
    }
  }
  return seen ? { linesAdded, linesRemoved } : undefined;
}

/** From a unified or Codex `apply_patch` text: `+`/`-` lines, headers aside. */
export function statsFromPatchText(text: unknown): EditStats | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("***")) continue;
    if (line.startsWith("+")) linesAdded += 1;
    else if (line.startsWith("-")) linesRemoved += 1;
  }
  return linesAdded || linesRemoved ? { linesAdded, linesRemoved } : undefined;
}

function leafName(toolName: string): string {
  return toolName.trim().toLowerCase().split(/[.:/]/).at(-1) ?? "";
}

/** The estimate from the call itself, for the tools that change files. */
export function statsFromInput(toolName: string, input: unknown): EditStats | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  switch (leafName(toolName)) {
    case "write":
    case "write_file":
    case "create_file": {
      const linesAdded = lineCount(i.content ?? i.contents ?? i.text);
      return linesAdded > 0 ? { linesAdded, linesRemoved: 0 } : undefined;
    }
    case "edit":
    case "edit_file":
    case "str_replace_editor":
    case "str_replace_based_edit_tool": {
      const linesRemoved = lineCount(i.old_string ?? i.old_str);
      const linesAdded = lineCount(i.new_string ?? i.new_str ?? i.code_edit);
      return linesAdded || linesRemoved ? { linesAdded, linesRemoved } : undefined;
    }
    case "multiedit": {
      const edits = Array.isArray(i.edits) ? i.edits : [];
      let linesAdded = 0;
      let linesRemoved = 0;
      for (const edit of edits) {
        const stats = statsFromInput("edit", edit);
        linesAdded += stats?.linesAdded ?? 0;
        linesRemoved += stats?.linesRemoved ?? 0;
      }
      return linesAdded || linesRemoved ? { linesAdded, linesRemoved } : undefined;
    }
    case "apply_patch":
      return statsFromPatchText(i.patch ?? i.input ?? i.diff);
    default:
      return undefined;
  }
}

/** The patch when there is one, the estimate otherwise. */
export function editStats(toolName: string, input: unknown, patch?: unknown): EditStats | undefined {
  return statsFromPatch(patch) ?? statsFromInput(toolName, input);
}

/**
 * Structured patches keyed by the tool call they answer, from the transcript
 * rows that carry a result. Only rows that mention one are parsed.
 */
export function patchStatsByToolUse(
  lines: readonly string[],
  parse: (line: string) => any,
): Map<string, EditStats> {
  const out = new Map<string, EditStats>();
  for (const line of lines) {
    if (!line.includes("structuredPatch")) continue;
    const row = parse(line);
    const patch = row?.toolUseResult?.structuredPatch;
    const blocks = row?.message?.content;
    if (!patch || !Array.isArray(blocks)) continue;
    const stats = statsFromPatch(patch);
    if (!stats) continue;
    for (const block of blocks) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        out.set(block.tool_use_id, stats);
      }
    }
  }
  return out;
}
