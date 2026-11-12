import {ts} from '../../../support/common';

/** Background work the chat started and has not heard back from, keyed by the launching tool call. */
export type ClaudeBackgroundWork = {taskId?: string; until: number};
/** The subscription window that refused the chat's last request. */
export type ClaudeUsageLimit = {resetsAt: number; window?: string};
export type ClaudeWaits = {background?: Record<string, ClaudeBackgroundWork>; limit?: ClaudeUsageLimit};

const BASH_DEFAULT_MS = 600_000, LONGEST_MS = 7_200_000, MAX_TRACKED = 32;
const BASH_LAUNCH = /^Command running in background with ID: ([\w-]+)/;
const AGENT_LAUNCH = /^Async agent launched/;
const AGENT_ID = /agentId: ([\w-]+)/;
const launched = new Map<string, {name: string; timeout?: number}>();

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => typeof block?.text === 'string' ? block.text
    : typeof block?.content === 'string' ? block.content : '').join('\n');
}

/** Bash reports its own bound; an agent is given the longest a background command may run. */
function bound(name: string | undefined, timeout: unknown): number {
  if (name !== 'Bash') return LONGEST_MS;
  return typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, LONGEST_MS) : BASH_DEFAULT_MS;
}

function noteLaunch(block: any, at: number, waits: ClaudeWaits): void {
  const id = String(block.tool_use_id ?? ''), body = text(block.content);
  if (!id || block.is_error === true) { if (id && waits.background) delete waits.background[id]; return; }
  const bash = BASH_LAUNCH.exec(body), agent = AGENT_LAUNCH.test(body) ? AGENT_ID.exec(body) : null;
  if (!bash && !AGENT_LAUNCH.test(body)) return;
  const call = launched.get(id);
  const background = waits.background ??= {};
  background[id] = {taskId: bash?.[1] ?? agent?.[1], until: at + bound(call?.name ?? (bash ? 'Bash' : 'Agent'), call?.timeout)};
  const ids = Object.keys(background);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED))) delete background[old];
}

function noteNotifications(body: string, waits: ClaudeWaits): void {
  if (!waits.background || !body.includes('<task-notification>')) return;
  for (const note of body.split('<task-notification>').slice(1)) {
    const status = /<status>([^<]+)<\/status>/.exec(note)?.[1];
    if (status === 'running') continue;
    const toolUse = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(note)?.[1];
    const taskId = /<task-id>([^<]+)<\/task-id>/.exec(note)?.[1];
    for (const [id, work] of Object.entries(waits.background)) {
      if (id === toolUse || (taskId && work.taskId === taskId)) delete waits.background[id];
    }
  }
}

function usageLimit(row: any): ClaudeUsageLimit | undefined {
  if (row.isApiErrorMessage !== true) return;
  const quota = row.quotaLimits ?? row.apiErrorParams?.rate_limit_info;
  const resetsAt = Number(quota?.resetsAt);
  if (quota?.status !== 'rejected' || !Number.isFinite(resetsAt) || resetsAt <= 0) return;
  const window = typeof quota.rateLimitType === 'string' ? quota.rateLimitType.slice(0, 40) : undefined;
  return {resetsAt: resetsAt * 1_000, ...(window ? {window} : {})};
}

/**
 * What a root Claude row says about the chat waiting on something other than the person:
 * background work that will resume it, or a subscription window that refused it.
 */
export function observeClaudeWaits(row: any, waits: ClaudeWaits): void {
  const at = ts(row.timestamp) || Date.now(), content = row.message?.content;
  if (row.type === 'assistant') {
    waits.limit = usageLimit(row);
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        launched.set(block.id, {name: String(block.name ?? ''), timeout: block.input?.timeout});
        while (launched.size > 512) launched.delete(launched.keys().next().value!);
      }
    }
    return;
  }
  if (row.type !== 'user' && row.type !== 'queue-operation') return;
  const body = typeof row.content === 'string' ? row.content : text(content);
  noteNotifications(body, waits);
  if (row.type === 'user' && !body.includes('<task-notification>')) waits.limit = undefined;
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'tool_result') noteLaunch(block, at, waits);
  }
}

/** Published only once the turn has ended: before that the chat is simply working. */
export function claudeWaits(waits: ClaudeWaits, turnEnded: boolean | undefined, now = Date.now()):
  {backgroundTasks?: number; usageLimit?: ClaudeUsageLimit} {
  if (!turnEnded) return {};
  const pending = Object.values(waits.background ?? {}).filter(work => work.until > now).length;
  return {...(pending ? {backgroundTasks: Math.min(pending, 32)} : {}),
    ...(waits.limit ? {usageLimit: waits.limit} : {})};
}
