import { claudeTranscriptRecord } from '../../sessions/support/activity-helpers';
import { childTitle } from '../../sessions/support/child-threads';
import { sensitivePath, statsFromInput, statsFromPatch } from '../../sessions/support/edit-stats';
import { redactSecrets } from '../../sessions/telemetry/command-preview';
import type { RecordedFileChange } from '../changes';
import { changeFolder } from './folders';

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit']);
const AGENT_TOOLS = new Set(['agent', 'task']);
const MAX_DIFF = 16_384;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ClaudeCallSink = {
  /** A file edit whose result came back without an error. */
  edit(callId: string, change: RecordedFileChange): void;
  /** A call that started a nested agent, with the description it was given. */
  launch(callId: string, description: string | undefined): void;
  /** That call's result named the agent it started. */
  agent(callId: string, agentId: string): void;
};

const leaf = (name: unknown) => String(name ?? '').trim().toLowerCase().split(/[.:/]/).at(-1) ?? '';

function marked(value: unknown, mark: string): string[] {
  return typeof value === 'string' && value ? value.replace(/\n$/, '').split('\n').map(line => mark + line) : [];
}

function inputLines(tool: string, input: Record<string, unknown>): string[] {
  if (tool === 'write') return marked(input.content, '+');
  const edits = tool === 'multiedit' && Array.isArray(input.edits) ? input.edits : [input];
  return edits.flatMap((edit: any) => [...marked(edit?.old_string, '-'), ...marked(edit?.new_string, '+')]);
}

function patchLines(patch: unknown): string[] {
  if (!Array.isArray(patch)) return [];
  return patch.flatMap((hunk: any) => Array.isArray(hunk?.lines)
    ? hunk.lines.filter((line: unknown): line is string => typeof line === 'string') : []);
}

/**
 * One successful Claude file edit. The host's own patch is exact when its
 * result row carries one; otherwise the call's old and new text is the
 * honest estimate, the same one the transcript row's "+n −m" uses.
 * A file that must not travel is left out, like Codex's recorded edits.
 */
export function claudeEditChange(tool: string, input: Record<string, unknown>, result: any): RecordedFileChange | undefined {
  const path = typeof input.file_path === 'string' ? input.file_path.trim() : '';
  if (!path || sensitivePath(path)) return undefined;
  const patch = result && typeof result === 'object' && result.filePath === input.file_path ? result.structuredPatch : undefined;
  const hunks = patchLines(patch);
  const stats = (hunks.length ? statsFromPatch(patch) : undefined) ?? statsFromInput(tool, input)
    ?? { linesAdded: 0, linesRemoved: 0 };
  const clean = redactSecrets((hunks.length ? hunks : inputLines(tool, input)).join('\n'));
  const folder = changeFolder(path);
  return { path: path.slice(0, 2048), ...stats, diff: clean.slice(0, MAX_DIFF),
    ...(clean.length > MAX_DIFF ? { diffTruncated: true } : {}), ...(folder ? { folder } : {}) };
}

/**
 * Pairs Claude tool calls with their results one row at a time, so a growing
 * transcript is read once. A row that answers several calls at once carries
 * no per-call result detail; its edits fall back to their inputs.
 */
export function createClaudeCallReader(sink: ClaudeCallSink): (row: any) => void {
  const pending = new Map<string, { tool: string; input: Record<string, unknown> }>();
  return row => {
    const blocks = row?.message?.content;
    if (!Array.isArray(blocks) || !claudeTranscriptRecord(row)) return;
    const results = blocks.filter((block: any) => block?.type === 'tool_result').length;
    const detail = results === 1 ? row.toolUseResult : undefined;
    for (const block of blocks) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && block.input && typeof block.input === 'object') {
        const tool = leaf(block.name);
        if (AGENT_TOOLS.has(tool)) sink.launch(block.id, childTitle(block.input.description));
        else if (EDIT_TOOLS.has(tool)) {
          if (pending.size >= 256) pending.delete(pending.keys().next().value!);
          pending.set(block.id, { tool, input: block.input });
        }
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        if (typeof detail?.agentId === 'string' && AGENT_ID.test(detail.agentId)) sink.agent(block.tool_use_id, detail.agentId);
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id);
        const change = block.is_error === true ? undefined : claudeEditChange(call.tool, call.input, detail);
        if (change) sink.edit(block.tool_use_id, change);
      }
    }
  };
}
