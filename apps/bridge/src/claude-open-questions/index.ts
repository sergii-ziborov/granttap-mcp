import type { RelayClient } from '../../../../packages/core/relay-client';
import type { SessionInfo, UserMessage } from '../../../../packages/protocol/schema';
import { nativeTranscriptSource, restoreNativeTranscriptSource } from '../sessions';
import { handleInboundUserMessage } from '../monitor/message-delivery';
import { sendDeliveryReceipt } from '../monitor/handlers/receipts';
import { openQuestionClosed } from './observations';
import { forgetOpenQuestion, readOpenQuestion, saveOpenQuestion, storedOpenQuestions,
  type OpenQuestionRecord } from './records';
import { observedOpenQuestion } from './source';
export { DEFERRED_QUESTION_REASON } from './observations';

/** The chat waits for the person however long it takes; a week bounds what the phone keeps. */
export const OPEN_QUESTION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const QUIET_AFTER_MS = 60 * 60_000;
const expired = (record: OpenQuestionRecord) => Date.now() - record.createdAt > OPEN_QUESTION_RETENTION_MS;

/** A question a Claude chat stopped on stays on the phone until it is answered anywhere. */
export async function publishClaudeOpenQuestions(client: RelayClient, sessions: SessionInfo[],
  options: { replay?: boolean; peerPublicKey?: string; requestId?: string } = {}): Promise<void> {
  const chats = [...new Map(sessions.filter(s => s.agent === 'claude'
    && Date.now() - s.lastActivityAt <= OPEN_QUESTION_RETENTION_MS).map(s => [s.sessionId, s])).values()];
  if (!chats.length) return;
  const stored = (options.requestId
    ? [readOpenQuestion(options.requestId)].filter((record): record is OpenQuestionRecord => !!record)
    : storedOpenQuestions()).filter(record => {
    // Even a chat that left every list cannot keep its records forever.
    if (Date.now() - record.createdAt <= 2 * OPEN_QUESTION_RETENTION_MS) return true;
    forgetOpenQuestion(record.requestId);
    return false;
  });
  for (const session of chats) {
    // History can hold hundreds of chats; let relay traffic through between them.
    await new Promise(resolve => setImmediate(resolve));
    const records = stored.filter(q => q.room === client.room && q.sessionId === session.sessionId);
    // A working chat is not stopped on a question; read it only to close one it left open.
    if (session.state === 'working' && !records.some(q => !q.resolvedSent)) continue;
    const path = nativeTranscriptSource(session);
    if (!path) continue;
    let observed;
    try { observed = observedOpenQuestion(session.sessionId, path); }
    catch { continue; }
    const open = observed.open;
    if (open && !records.some(q => q.requestId === open.requestId) && !readOpenQuestion(open.requestId)
      && Date.now() - open.createdAt <= OPEN_QUESTION_RETENTION_MS) {
      const record = { ...open, room: client.room, sourcePath: path };
      saveOpenQuestion(record);
      records.push(record);
    }
    for (const candidate of records.sort((a, b) => a.createdAt - b.createdAt)) {
      if (options.requestId && candidate.requestId !== options.requestId) continue;
      const record = readOpenQuestion(candidate.requestId);
      if (!record || record.room !== client.room || record.sessionId !== session.sessionId) continue;
      if (!record.answered && openQuestionClosed(record, observed)) {
        record.answered = true;
        saveOpenQuestion(record);
      }
      await announceOrResolve(client, session, record, options);
    }
  }
}

async function announceOrResolve(client: RelayClient, session: SessionInfo, record: OpenQuestionRecord,
  options: { replay?: boolean; peerPublicKey?: string }): Promise<void> {
  if (record.answered || expired(record)) {
    // A phone keeps a card no longer than the retention, so older ones need no repeat.
    if (!record.resolvedSent || options.replay && !expired(record)) {
      await resolveQuestion(client, record, options.peerPublicKey, !record.answered);
      saveOpenQuestion({ ...record, resolvedSent: true });
    } else if (expired(record)) forgetOpenQuestion(record.requestId);
    return;
  }
  if (record.announced && !options.replay) return;
  // A question found long after it was asked (an update, a waking Mac) arrives quietly.
  const wake = !record.announced && Date.now() - record.createdAt <= QUIET_AFTER_MS;
  const text = [record.question, ...record.options.map(value => '• ' + value)].join('\n');
  await client.send({ type: 'agent.event', kind: 'question', requestId: record.requestId,
    sessionId: session.sessionId, agent: 'claude', projectId: session.projectId,
    taskId: session.taskId, computerId: session.computerId, text, createdAt: record.createdAt },
  'phone', { ttlMs: Math.max(1, record.createdAt + OPEN_QUESTION_RETENTION_MS - Date.now()),
    wake, urgent: true, peerPublicKey: options.peerPublicKey,
    deliveryId: 'native-question-' + record.requestId });
  saveOpenQuestion({ ...record, announced: true });
}

/** Restore one notification from private owned records; catalog discovery is not a prerequisite. */
export async function replayClaudeOpenQuestion(client: RelayClient, requestId: string,
  peerPublicKey?: string): Promise<boolean> {
  if (!peerPublicKey) return false;
  const record = readOpenQuestion(requestId);
  if (!record || record.room !== client.room) return false;
  const identity = { sessionId: record.sessionId, agent: 'claude' as const };
  if (!nativeTranscriptSource(identity)
    && (!record.sourcePath || !restoreNativeTranscriptSource(identity, record.sourcePath))) return false;
  const session: SessionInfo = { ...identity, state: 'idle', startedAt: record.createdAt,
    lastActivityAt: record.createdAt, tokensSession: 0, tokensLastTurn: 0 };
  await publishClaudeOpenQuestions(client, [session], { replay: true, peerPublicKey, requestId });
  return true;
}

/** The answer is an ordinary message to the stopped chat: same policy, queue and receipts. */
export async function handleClaudeOpenQuestionReply(client: RelayClient, message: UserMessage,
  publish: () => Promise<void>, peerPublicKey?: string,
  deliver = handleInboundUserMessage): Promise<boolean> {
  if (!message.requestId || !peerPublicKey) return false;
  const record = readOpenQuestion(message.requestId);
  if (!record || record.room !== client.room || record.sessionId !== message.sessionId) return false;
  const path = nativeTranscriptSource({ sessionId: record.sessionId, agent: 'claude' });
  if (!path) return false;
  try {
    if (!record.answered && openQuestionClosed(record, observedOpenQuestion(record.sessionId, path))) {
      record.answered = true;
      saveOpenQuestion(record);
    }
  } catch { return false; }
  if (record.answered || expired(record)) {
    if (message.messageId) await sendDeliveryReceipt(client, message.messageId, 'rejected',
      record.answered ? 'This question was already answered at the computer.' : 'This question has expired.',
      record.sessionId, peerPublicKey);
    await resolveQuestion(client, record, peerPublicKey, !record.answered);
    return true;
  }
  if (!message.text.trim() || message.text.length > 4_000) return false;
  return deliver(client, { ...message, requestId: undefined,
    messageId: message.messageId ?? 'claude-answer-' + record.requestId }, publish, peerPublicKey);
}

function resolveQuestion(client: RelayClient, record: OpenQuestionRecord, peerPublicKey?: string, lapsed = false) {
  return client.send({ type: 'approval.resolved', requestId: record.requestId,
    sessionId: record.sessionId, status: lapsed ? 'expired' : 'applied',
    nativeUiCleared: record.answered === true, resolvedAt: Date.now() },
  'phone', { ttlMs: 15 * 60_000, wake: false, peerPublicKey });
}
