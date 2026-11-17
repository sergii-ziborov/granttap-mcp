/**
 * What a provider scan tells the catalog about where its sessions came from, never published.
 *
 * A session says whether it was started headless and how its first request opened. A chat's
 * transcript says which commands it ran that start another provider's headless session, with the
 * command in `lineageText` spelling and the time it ran: from the call until its result, or, for a
 * Claude command sent to the background, until Claude's notification that it finished. Beside them, the
 * folders those commands named (`launches`), which outlast the commands. These are read with the
 * transcript the scanner already reads, row by row, and held in memory only.
 */
import { createFolderLaunches, type FolderLaunch } from "./folders/launches";
import { headlessTargets, lineageText, type LineageAgent, type PromptLead } from "./headless";

/** A command a chat ran that starts another provider's session headless. */
export type LineageCall = {
  targets: LineageAgent[];
  /** The command in `lineageText` spelling, at most `MAX_COMMAND_CHARS`. */
  command: string;
  startedAt: number;
  /** Absent while the command still runs, as far as the transcript tells. */
  endedAt?: number;
};

export type LineageFact = {
  agent: LineageAgent;
  sessionId: string;
  cwd?: string;
  startedAt: number;
  /** Started without a person at a terminal (`codex exec`, `claude -p`, a headless Grok session). */
  headless?: boolean;
  /** The opening of its first request, for a session long enough to be found in a parent's command. */
  prompt?: PromptLead;
  calls?: LineageCall[];
  /** The folders the chat started another provider headless in, per folder and provider. */
  launches?: FolderLaunch[];
  /**
   * The computer the session was read on, when not this one: a provider's history read here is this
   * computer's. A parent on another computer is never matched.
   */
  computerId?: string;
};

const MAX_CALLS = 32;
export const MAX_COMMAND_CHARS = 8_192;

function stamp(value: unknown): number {
  const at = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(at) ? at : 0;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => typeof block === "string" ? block
    : typeof block?.text === "string" ? block.text : "").join("\n");
}

type OpenCall = LineageCall & { background?: boolean };

/** The calls one transcript has shown so far, oldest let go first. */
function createCalls() {
  const open = new Map<string, OpenCall>();
  const done: LineageCall[] = [];
  const launches = createFolderLaunches();
  const finish = (id: string, at: number) => {
    const call = open.get(id);
    if (!call) return;
    open.delete(id);
    done.push({ targets: call.targets, command: call.command, startedAt: call.startedAt, endedAt: Math.max(at, call.startedAt) });
    if (done.length > MAX_CALLS) done.splice(0, done.length - MAX_CALLS);
  };
  return {
    open,
    begin(id: unknown, command: unknown, at: number): void {
      if (typeof command !== "string" || !at) return;
      const targets = headlessTargets(command);
      launches.note(command, targets, at);
      if (typeof id !== "string" || targets.length === 0) return;
      open.set(id, { targets, command: lineageText(command.slice(0, MAX_COMMAND_CHARS * 2)).slice(0, MAX_COMMAND_CHARS), startedAt: at });
      if (open.size > MAX_CALLS) open.delete(open.keys().next().value!);
    },
    finish,
    snapshot(): LineageCall[] {
      return [...done, ...[...open.values()].map(({ targets, command, startedAt }) => ({ targets, command, startedAt }))]
        .sort((left, right) => left.startedAt - right.startedAt).slice(-MAX_CALLS);
    },
    launches: launches.snapshot,
  };
}

export type LineageCalls = {
  add: (row: any) => void;
  snapshot: () => LineageCall[];
  /** The folders this transcript's commands started a provider headless in. */
  launches: () => FolderLaunch[];
};

/** Claude: a Bash `tool_use`, its `tool_result`, and for a background command the task notification. */
export function createClaudeLineageCalls(): LineageCalls {
  const calls = createCalls();
  return {
    add(row: any): void {
      const content = row?.message?.content;
      if (row?.type === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_use") calls.begin(block.id, block.input?.command, stamp(row.timestamp));
        }
        return;
      }
      if (calls.open.size === 0 || (row?.type !== "user" && row?.type !== "queue-operation")) return;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== "tool_result" || !calls.open.has(block.tool_use_id)) continue;
          // A command sent to the background answers at once and runs on; its notification ends it.
          if (typeof row.toolUseResult?.backgroundTaskId === "string") calls.open.get(block.tool_use_id)!.background = true;
          else calls.finish(block.tool_use_id, stamp(row.timestamp));
        }
      }
      const text = textOf(content ?? row?.content);
      if (!text.includes("<task-notification>")) return;
      for (const match of text.matchAll(/<tool-use-id>([A-Za-z0-9_-]{1,128})<\/tool-use-id>/g)) {
        if (calls.open.get(match[1]!)?.background) calls.finish(match[1]!, stamp(row.timestamp));
      }
    },
    snapshot: calls.snapshot,
    launches: calls.launches,
  };
}

/** The command a Codex call runs: `exec_command`, `shell` and `local_shell` arguments, or code-mode `exec` input. */
function codexCommand(payload: any): string | undefined {
  if (payload?.type === "custom_tool_call") {
    return ["exec", "functions.exec"].includes(payload.name) && typeof payload.input === "string" ? payload.input : undefined;
  }
  if (payload?.type === "local_shell_call") {
    const command = payload.action?.command;
    return Array.isArray(command) ? command.join(" ") : undefined;
  }
  if (payload?.type !== "function_call" || typeof payload.arguments !== "string") return undefined;
  if (!["exec_command", "functions.exec_command", "shell", "container.exec"].includes(payload.name)) return undefined;
  try {
    const args = JSON.parse(payload.arguments) as { cmd?: unknown; command?: unknown };
    const command = args.cmd ?? args.command;
    return Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : undefined;
  } catch {
    return undefined;
  }
}

/** Codex: a call and its output by `call_id`; an output that says the process runs on leaves it open. */
export function createCodexLineageCalls(): LineageCalls {
  const calls = createCalls();
  return {
    add(row: any): void {
      if (row?.type !== "response_item") return;
      const payload = row.payload;
      const at = stamp(row.timestamp);
      const command = codexCommand(payload);
      if (command !== undefined) { calls.begin(payload.call_id, command, at); return; }
      if (calls.open.size === 0 || !/_output$/.test(String(payload?.type ?? "")) || !calls.open.has(payload.call_id)) return;
      const output = textOf(typeof payload.output === "string" ? payload.output : payload.output?.content ?? payload.output);
      if (/Process running with session ID/i.test(output.slice(0, 4_096))) return;
      calls.finish(payload.call_id, at);
    },
    snapshot: calls.snapshot,
    launches: calls.launches,
  };
}
