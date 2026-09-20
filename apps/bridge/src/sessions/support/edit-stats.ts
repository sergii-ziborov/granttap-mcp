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

export const MAX_DIFF_PREVIEW_LINES = 24;
export const MAX_DIFF_PREVIEW_CHARS = 2_400;
const MAX_DIFF_LINE_CHARS = 160;

/**
 * Files whose contents never travel, whatever the tool did to them: the
 * counts still say how much changed, the lines stay on the computer.
 */
const SENSITIVE_PATH = new RegExp(
  "(^|[\\/])(\\.env([.-][^\\/]*)?|[^\\/]*\\.(pem|key|p12|pfx|jks|keystore|crt)|id_(rsa|ed25519|ecdsa|dsa)"
  + "|[^\\/]*(secret|credential|password|passwd|token|private[-_]?key)[^\\/]*)$",
  "i",
);

export function sensitivePath(path: unknown): boolean {
  return typeof path === "string" && SENSITIVE_PATH.test(path.trim());
}

/**
 * A file that is a secret by its name alone: an env file, a key, a
 * credentials store. Narrower than `sensitivePath`, on purpose. Hiding a
 * preview of `tokenizer.ts` costs a glance; leaving it out of a checkpoint
 * loses the code, so a checkpoint excludes only what is a secret, not what
 * merely sounds like one.
 */
const SECRET_FILE = new RegExp(
  "(^|[\\/])("
  + "\\.env([.-][^\\/]*)?|[^\\/]+\\.env"
  + "|[^\\/]*\\.(pem|key|p12|pfx|jks|keystore|der|gpg|asc|kdbx|ovpn|tfstate|tfstate\\.backup)"
  + "|id_(rsa|ed25519|ecdsa|dsa)(\\.pub)?"
  + "|credentials(\\.json|\\.ya?ml)?|secrets?(\\.json|\\.ya?ml|\\.toml)|[^\\/]*\\.secrets?"
  + "|service[-_]account[^\\/]*\\.json"
  + "|\\.npmrc|\\.netrc|\\.pypirc|\\.htpasswd|\\.git-credentials|\\.docker[\\/]config\\.json"
  + ")$",
  "i",
);

export function secretFilePath(path: unknown): boolean {
  return typeof path === "string" && SECRET_FILE.test(path.trim());
}

/** Bound the lines and their length, and say how many were left out. */
function boundPreview(lines: string[], redact: (line: string) => string): string | undefined {
  const kept: string[] = [];
  let chars = 0;
  for (const raw of lines) {
    if (kept.length >= MAX_DIFF_PREVIEW_LINES || chars >= MAX_DIFF_PREVIEW_CHARS) break;
    const line = redact(raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
    const bounded = line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS - 1)}…` : line;
    kept.push(bounded);
    chars += bounded.length + 1;
  }
  if (kept.length === 0) return undefined;
  const left = lines.length - kept.length;
  if (left > 0) kept.push(`… ${left} more line${left === 1 ? "" : "s"}`);
  return kept.join("\n");
}

/** The patch's own lines, with their + − and context marks. */
export function diffPreviewFromPatch(patch: unknown, redact: (line: string) => string = (line) => line): string | undefined {
  if (!Array.isArray(patch)) return undefined;
  const lines: string[] = [];
  for (const hunk of patch) {
    const hunkLines = (hunk as { lines?: unknown } | null)?.lines;
    if (!Array.isArray(hunkLines)) continue;
    for (const line of hunkLines) if (typeof line === "string") lines.push(line);
  }
  return boundPreview(lines, redact);
}

function prefixed(value: unknown, mark: string): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  const lines = value.split("\n");
  if (value.endsWith("\n")) lines.pop();
  return lines.map((line) => mark + line);
}

/** The estimate from the call: a created file is all additions, an edit is out then in. */
export function diffPreviewFromInput(
  toolName: string, input: unknown, redact: (line: string) => string = (line) => line,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  switch (leafName(toolName)) {
    case "write":
    case "write_file":
    case "create_file":
      return boundPreview(prefixed(i.content ?? i.contents ?? i.text, "+"), redact);
    case "edit":
    case "edit_file":
    case "str_replace_editor":
    case "str_replace_based_edit_tool":
      return boundPreview([
        ...prefixed(i.old_string ?? i.old_str, "-"),
        ...prefixed(i.new_string ?? i.new_str ?? i.code_edit, "+"),
      ], redact);
    case "multiedit": {
      const edits = Array.isArray(i.edits) ? i.edits : [];
      const lines = edits.flatMap((edit: unknown) => {
        const e = (edit && typeof edit === "object" ? edit : {}) as Record<string, unknown>;
        return [...prefixed(e.old_string, "-"), ...prefixed(e.new_string, "+")];
      });
      return boundPreview(lines, redact);
    }
    case "apply_patch": {
      const text = i.patch ?? i.input ?? i.diff;
      if (typeof text !== "string") return undefined;
      const lines = text.split("\n").filter((line) =>
        (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
        && !line.startsWith("+++") && !line.startsWith("---"));
      return boundPreview(lines, redact);
    }
    default:
      return undefined;
  }
}

export type PatchRecord = { stats: EditStats; preview?: string };

/**
 * Structured patches keyed by the tool call they answer, from the transcript
 * rows that carry a result. Only rows that mention one are parsed; a file
 * that must not travel keeps its counts and loses its lines.
 */
export function patchStatsByToolUse(
  lines: readonly string[],
  parse: (line: string) => any,
  redact: (line: string) => string = (line) => line,
): Map<string, PatchRecord> {
  const out = new Map<string, PatchRecord>();
  for (const line of lines) {
    if (!line.includes("structuredPatch")) continue;
    const row = parse(line);
    const patch = row?.toolUseResult?.structuredPatch;
    const blocks = row?.message?.content;
    if (!patch || !Array.isArray(blocks)) continue;
    const stats = statsFromPatch(patch);
    if (!stats) continue;
    const preview = sensitivePath(row?.toolUseResult?.filePath) ? undefined : diffPreviewFromPatch(patch, redact);
    for (const block of blocks) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        out.set(block.tool_use_id, { stats, preview });
      }
    }
  }
  return out;
}
