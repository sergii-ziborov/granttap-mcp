import type { ActivityEntry } from '../../../../../packages/protocol/schema';
import { classifyTool, pushEntry, stripTranscriptMarkup, visibleUserText } from '../../sessions/support/activity-helpers';
import { grokRecordedChanges, grokToolCalls, grokToolSummary } from '../grok-tools';
import { confirmedUpdateChanges } from '../acp-file-changes';
import { conversationImage, type ConversationImage } from './images';

export type ConversationProjection = {
  sessionId: string;
  entries: ActivityEntry[];
  calls: Map<string, { entry: ActivityEntry; proposed: NonNullable<ActivityEntry['fileChanges']> }>;
  speaking?: ActivityEntry;
  userKey?: string;
  bounded: boolean;
  text?: { entry: ActivityEntry; raw: string };
  sizes: Map<ActivityEntry, number>;
  bytes: number;
  textLimit: number;
  entryLimit: number;
  byteLimit: number;
  toolIds: Set<string>;
  images?: Map<string, ConversationImage>;
};

export function newProjection(sessionId: string, complete = false): ConversationProjection {
  return { sessionId, entries: [], calls: new Map(), bounded: false, sizes: new Map(), bytes: 0,
    textLimit: complete ? 16_000_000 : 65_536, entryLimit: complete ? 50_000 : 4096,
    byteLimit: complete ? 16_000_000 : 8 * 1024 * 1024, toolIds: new Set(),
    ...(complete ? { images: new Map() } : {}) };
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** ACP updates are visible history; model-only context, reasoning and hook output are excluded. */
export function projectConversationUpdate(state: ConversationProjection, value: unknown, offset: number): void {
  const row = object(value), params = object(row?.params), update = object(params?.update);
  if (row?.method !== 'session/update' || params?.sessionId !== state.sessionId || !update) return;
  const rawTime = row.timestamp;
  const at = typeof rawTime === 'number' ? (rawTime < 1e11 ? rawTime * 1_000 : rawTime)
    : typeof rawTime === 'string' ? Date.parse(rawTime) : NaN;
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 5_000) return;
  const kind = update.sessionUpdate;
  let changed: ActivityEntry | undefined;
  if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
    const content = object(update.content), meta = object(update._meta);
    if (meta?.syntheticReason != null || meta?.synthetic_reason != null) return;
    if (kind === 'user_message_chunk' && content?.type === 'image' && state.images) {
      const captured = conversationImage(content, state.sessionId, offset, at);
      if (!captured) { state.bounded = true; return; }
      state.entries.push(captured.entry); state.images.set(captured.entry.id, captured.image);
      state.bytes += captured.encodedBytes; state.speaking = undefined; state.userKey = undefined; state.text = undefined;
      boundProjection(state, captured.entry); return;
    }
    if (content?.type !== 'text' || typeof content.text !== 'string' || !content.text) {
      if (kind === 'user_message_chunk' && content?.type === 'image') state.bounded = true;
      return;
    }
    const user = kind === 'user_message_chunk';
    const promptIndex = meta?.promptIndex;
    const key = user && Number.isSafeInteger(promptIndex) && Number(promptIndex) >= 0
      ? `${state.sessionId}:native-user:${promptIndex}` : `${state.sessionId}:native:${offset}`;
    const previous = state.entries.at(-1);
    if (previous && (user && previous.kind === 'user' && state.userKey === key || !user && state.speaking === previous)) {
      const raw = (state.text?.entry === previous ? state.text.raw : previous.text) + content.text;
      state.text = { entry: previous, raw: raw.slice(0, state.textLimit) };
      previous.text = user ? visibleUserText(state.text.raw) : stripTranscriptMarkup(state.text.raw);
      if (raw.length > state.textLimit) state.bounded = true;
      boundProjection(state, previous);
      return;
    }
    const count = state.entries.length;
    pushEntry({ out: state.entries, seen: new Set(), sessionId: state.sessionId, kind: user ? 'user' : 'message',
      text: content.text.slice(0, state.textLimit), createdAt: at, ordinal: offset, idOverride: key, fullText: true });
    if (state.entries.length > count) {
      changed = state.entries.at(-1);
      state.text = { entry: changed!, raw: content.text.slice(0, state.textLimit) };
      if (user) { state.userKey = key; state.speaking = undefined; }
      else state.speaking = state.entries.at(-1);
    }
    if (content.text.length > state.textLimit) state.bounded = true;
  } else if (kind === 'tool_call') {
    changed = projectTool(state, update, at, offset);
  } else if (kind === 'tool_call_update') {
    const id = update.toolCallId, call = typeof id === 'string' ? state.calls.get(id) : undefined;
    if (call && update.status === 'completed') {
      changed = call.entry;
      const changes = call.proposed.length ? call.proposed : confirmedUpdateChanges(update.content);
      if (changes.length) call.entry.fileChanges = changes;
      call.proposed = [];
      call.entry.outcome = 'success';
      state.calls.delete(String(id));
    } else if (call && update.status === 'failed') {
      changed = call.entry;
      call.proposed = []; call.entry.outcome = 'error'; delete call.entry.fileChanges;
      state.calls.delete(String(id));
    }
  } else if (kind === 'turn_completed') {
    if (update.stop_reason === 'end_turn' && state.speaking && state.entries.at(-1) === state.speaking) {
      state.speaking.kind = 'final'; state.speaking.createdAt = Math.max(at, state.speaking.createdAt);
    }
    state.speaking = undefined;
  }
  boundProjection(state, changed);
}

function projectTool(state: ConversationProjection, update: Record<string, unknown>, at: number, offset: number): ActivityEntry | undefined {
  const native = object(object(update._meta)?.['x.ai/tool']);
  const call = grokToolCalls({ tool_calls: [{ id: update.toolCallId, name: native?.name, arguments: update.rawInput }] })[0];
  if (!call?.id || state.toolIds.has(call.id)) return;
  state.toolIds.add(call.id);
  state.speaking = undefined;
  const identity = classifyTool(call.name, call.input);
  pushEntry({ out: state.entries, seen: new Set(), sessionId: state.sessionId, kind: 'tool',
    text: grokToolSummary(call), createdAt: at, ordinal: offset, extras: identity,
    idOverride: `${state.sessionId}:tool:${call.id}` });
  const entry = state.entries.at(-1)!;
  const proposed = grokRecordedChanges(call, { name: call.name, outcome: 'success', at });
  state.calls.set(call.id, { entry, proposed });
  return entry;
}

function boundProjection(state: ConversationProjection, changed?: ActivityEntry): void {
  if (changed) {
    const bytes = Buffer.byteLength(JSON.stringify(changed));
    state.bytes += bytes - (state.sizes.get(changed) ?? 0); state.sizes.set(changed, bytes);
  }
  while (state.entries.length > state.entryLimit || state.bytes > state.byteLimit) {
    const removed = state.entries.shift();
    if (!removed) break;
    state.bytes -= state.sizes.get(removed) ?? 0; state.sizes.delete(removed);
    if (removed.kind === 'tool') state.toolIds.delete(removed.id.slice(`${state.sessionId}:tool:`.length));
    for (const [id, call] of state.calls) if (call.entry === removed) state.calls.delete(id);
    state.bounded = true;
  }
  if (state.calls.size > (state.images ? 50_000 : 256)) {
    state.calls.delete(state.calls.keys().next().value!); state.bounded = true;
  }
}
