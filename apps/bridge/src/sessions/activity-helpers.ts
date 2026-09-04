/**
 * Visible activity extraction helpers.
 * Only user-visible assistant text and compact tool summaries are extracted.
 * Provider-specific thinking/reasoning blocks are deliberately ignored.
 */
import type { ActivityEntry } from "../../../../packages/protocol/schema";
import {
  parseMcpToolName,
  skillNameFromInput,
} from "./telemetry";

export { estimateTokens, parseMcpToolName } from "./telemetry";

export const MAX_ACTIVITY_ENTRIES = 24;
export const MAX_ACTIVITY_TEXT = 700;

export function compact(value: unknown, max = MAX_ACTIVITY_TEXT): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function activityText(value: unknown, max = MAX_ACTIVITY_TEXT): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Remove host-injected transport context that is not a message the person typed. */
/**
 * The note GrantTap itself appends when a phone message carries attachments,
 * so the provider's log shows the words the person typed and the phone can
 * recognise them as its own bubble rather than render the prompt twice.
 */
export function stripAttachmentNote(text: string): string {
  return text.replace(
    /\n\nAttached files available locally(?: \(inspect them as part of this request\))?:\n(?:- [^\n]*(?:\n|$))+$/,
    "",
  ).trim();
}

export function visibleUserText(value: unknown): string {
  const text = stripAttachmentNote(String(value ?? "").trim());
  if (!text) return "";
  // The host's own notes about what it showed the model: nobody typed them.
  if (text.startsWith("[Image: original ") || text.startsWith("<local-command-caveat>")) return "";
  if (/^(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/.test(text)) return "";
  if (/^#\s+AGENTS\.md instructions for(?:\s|$)/i.test(text)) return "";
  const internal = [
    "recommended_plugins",
    "environment_context",
    "app-context",
    "permissions instructions",
    "collaboration_mode",
    "apps_instructions",
    "plugins_instructions",
    "skills_instructions",
  ];
  if (internal.some((tag) => text.startsWith(`<${tag}`)) || text.startsWith("<image name=")) {
    return "";
  }
  const marker = /^##\s+My request(?: for Codex)?:\s*$/im.exec(text);
  return marker ? text.slice(marker.index + marker[0].length).trim() : text;
}

/**
 * A background-task event the host writes into the transcript as a "user"
 * turn. Nobody typed it, so it is not the person's message; it is a status
 * line about a command that finished, and reads as one.
 */
export function harnessTaskNotification(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!text.startsWith("<task-notification>") && !text.startsWith("[SYSTEM NOTIFICATION")) return undefined;
  const block = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(text);
  if (!block) return undefined;
  const field = (name: string): string | undefined => {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block[1] ?? "");
    return match?.[1]?.trim() || undefined;
  };
  const summary = field("summary");
  if (summary) return compact(summary, 300);
  const status = field("status");
  return status ? `Background task ${compact(status, 40)}.` : "Background task finished.";
}

/**
 * What the host wrote into the transcript as a "user" turn that is a notice,
 * not a message: a finished background task, a slash command the person ran
 * in the terminal, or that command's output. Each reads as a status line.
 */
export function harnessUserNotice(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  const task = harnessTaskNotification(text);
  if (task) return task;
  const command = /^<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    const name = command[1]?.trim() ?? "";
    return name ? compact(args ? `${name} ${args}` : name, 200) : undefined;
  }
  const stdout = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/.exec(text);
  if (stdout) return compact(stdout[1]?.trim() || "", 300) || undefined;
  return undefined;
}

/** Map Cursor runtime MCP ids (`user-granttap`) onto mcp.json names (`granttap`). */
export function normalizeMcpServerName(raw: string): string {
  const name = raw.trim();
  if (!name) return name;
  if (name.startsWith("user-")) return name.slice("user-".length);
  return name;
}

export function toolSummary(name: unknown, input: unknown): string {
  const tool = compact(name || "tool", 80);
  if (typeof input === "string") return `${tool}: ${compact(input, 420)}`;
  if (!input || typeof input !== "object") return tool;
  const i = input as Record<string, unknown>;
  // Cursor MCP meta-tools carry server + toolName instead of mcp__server__tool.
  if (/^(CallMcpTool|GetMcpTools)$/i.test(tool) && typeof i.server === "string") {
    const server = normalizeMcpServerName(i.server);
    const inner =
      typeof i.toolName === "string" && i.toolName.trim()
        ? compact(i.toolName, 80)
        : tool;
    return `${server}/${inner}`;
  }
  const detail =
    i.command ?? i.cmd ?? i.file_path ?? i.path ?? i.url ?? i.query ?? i.description ?? i.skill;
  return detail == null ? tool : `${tool}: ${compact(detail, 420)}`;
}

/** Classify a tool name into MCP server / skill / plain CLI. */
export function classifyTool(
  name: unknown,
  input?: unknown,
): {
  toolName: string;
  mcpServer?: string;
  skill?: string;
} {
  const toolName = compact(String(name || "tool"), 120);
  const mcp = parseMcpToolName(toolName);
  if (mcp) return { toolName, mcpServer: mcp.server };
  // Cursor: CallMcpTool / GetMcpTools with { server, toolName }.
  if (
    /^(CallMcpTool|GetMcpTools)$/i.test(toolName) &&
    input &&
    typeof input === "object"
  ) {
    const i = input as Record<string, unknown>;
    if (typeof i.server === "string" && i.server.trim()) {
      const inner =
        typeof i.toolName === "string" && i.toolName.trim()
          ? compact(i.toolName, 120)
          : toolName;
      return {
        toolName: inner,
        mcpServer: normalizeMcpServerName(i.server),
      };
    }
  }
  const skill = toolName.match(/^(?:skill__|Skill\()(.+?)\)?$/i);
  if (skill) return { toolName, skill: skill[1] };
  if (/^Skill$/i.test(toolName)) {
    return { toolName, skill: skillNameFromInput(input) ?? "skill" };
  }
  return { toolName };
}

export function pushEntry(
  out: ActivityEntry[],
  seen: Set<string>,
  sessionId: string,
  kind: ActivityEntry["kind"],
  text: unknown,
  createdAt: number,
  ordinal: number,
  extras: Partial<
    Pick<
      ActivityEntry,
      | "toolName"
      | "mcpServer"
      | "skill"
      | "estimatedContextTokens"
      | "capabilities"
      | "durationMs"
      | "childThreadId"
      | "childThreadTitle"
      | "childThreadDepth"
    >
  > = {},
  idOverride?: string,
): void {
  // The host's own notices arrive as "user" turns; they are shown as status.
  const notification = kind === "user" ? harnessUserNotice(text) : undefined;
  const shownKind: ActivityEntry["kind"] = notification ? "status" : kind;
  const clean = activityText(notification ?? (kind === "user" ? visibleUserText(text) : text));
  if (!clean) return;
  const duplicateKey = `${extras.childThreadId ?? "root"}:${shownKind}:${extras.toolName ?? ""}:${clean}`;
  if (seen.has(duplicateKey)) return;
  seen.add(duplicateKey);
  out.push({
    id: idOverride ?? `${sessionId}:${createdAt}:${ordinal}`,
    kind: shownKind,
    text: clean,
    createdAt,
    ...extras,
  });
}
