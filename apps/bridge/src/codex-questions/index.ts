import type { RelayClient } from '../../../../packages/core/relay-client';
import type { SessionInfo, UserMessage } from '../../../../packages/protocol/schema';
import { nativeTranscriptSource, restoreNativeTranscriptSource } from '../sessions';
import { handleInboundUserMessage } from '../monitor/message-delivery';
import { sendDeliveryReceipt } from '../monitor/handlers/receipts';
import { nativeAnswerEnvelope } from './observations';
import { readQuestion, saveQuestion, storedQuestions, type QuestionRecord } from './records';
import { observedQuestions } from './source';
export { codexQuestionText } from './observations';

const RETENTION_MS = 24 * 60 * 60_000;

/** Phone questions travel as device-encrypted control events, independently of task-key grants. */
export async function publishCodexQuestions(client: RelayClient, sessions: SessionInfo[],
  options: { replay?: boolean; peerPublicKey?: string; requestId?: string } = {}): Promise<void> {
  for (const session of sessions.filter(s => s.agent === 'codex')) {
    const path = nativeTranscriptSource(session);
    if (!path) continue;
    let observed;
    try { observed = observedQuestions(session.sessionId, path); }
    catch { continue; }
    for (const question of observed.questions) {
      if (Date.now() - question.createdAt > RETENTION_MS) continue;
      const existing = readQuestion(question.requestId);
      if (!existing) saveQuestion({ ...question, room: client.room, sourcePath: path });
      else if (existing.room === client.room && existing.sourcePath !== path) saveQuestion({ ...existing, sourcePath: path });
    }
    const records = storedQuestions().filter(q => q.room === client.room && q.sessionId === session.sessionId
      && (!options.requestId || q.requestId === options.requestId))
      .sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);
    for (const record of records) {
      const expired = Date.now() - record.createdAt > RETENTION_MS;
      if (observed.answered.has(record.requestId) && !record.answered) {
        record.answered = true;
        saveQuestion(record);
      }
      if (record.answered || expired) {
        if (!record.resolvedSent || options.replay) {
          await resolveQuestion(client, record, options.peerPublicKey, expired);
          saveQuestion({ ...record, resolvedSent: true });
        }
      } else if (!record.announced || options.replay) {
        const text = [record.question, ...record.options.map(value => '• ' + value)].join('\n');
        await client.send({ type: 'agent.event', kind: 'question', requestId: record.requestId,
          questionReplyFormat: 'attachments-v1',
          sessionId: session.sessionId, agent: 'codex', projectId: session.projectId,
          taskId: session.taskId, computerId: session.computerId, text, createdAt: record.createdAt },
        'phone', { ttlMs: Math.max(1, record.createdAt + RETENTION_MS - Date.now()),
          wake: !record.announced, urgent: true, peerPublicKey: options.peerPublicKey,
          deliveryId: 'native-question-' + record.requestId });
        saveQuestion({ ...record, announced: true });
      }
    }
  }
}

/** Restore one notification from private owned records; catalog discovery is not a prerequisite. */
export async function replayCodexQuestion(client: RelayClient, requestId: string, peerPublicKey?: string): Promise<boolean> {
  if (!peerPublicKey) return false;
  const record = readQuestion(requestId);
  if (!record || record.room !== client.room) return false;
  const identity = { sessionId: record.sessionId, agent: 'codex' as const };
  if (!nativeTranscriptSource(identity)
    && (!record.sourcePath || !restoreNativeTranscriptSource(identity, record.sourcePath))) return false;
  const session: SessionInfo = { ...identity, state: 'idle', startedAt: record.createdAt,
    lastActivityAt: record.createdAt, tokensSession: 0, tokensLastTurn: 0 };
  await publishCodexQuestions(client, [session], { replay: true, peerPublicKey, requestId });
  return true;
}

/** Reuse ordinary scoped delivery, policy and receipts; only the human's explicit answer is wrapped. */
export async function handleCodexQuestionReply(client: RelayClient, message: UserMessage,
  publish: () => Promise<void>, peerPublicKey?: string,
  deliver = handleInboundUserMessage): Promise<boolean> {
  if (!message.requestId || !peerPublicKey) return false;
  const record = readQuestion(message.requestId);
  if (!record || record.room !== client.room || record.sessionId !== message.sessionId) return false;
  const path = nativeTranscriptSource({ sessionId: record.sessionId, agent: 'codex' });
  if (!path) return false;
  try {
    if (observedQuestions(record.sessionId, path).answered.has(record.requestId)) {
      record.answered = true;
      saveQuestion(record);
    }
  } catch { return false; }
  if (record.answered || Date.now() - record.createdAt > RETENTION_MS) {
    if (message.messageId) await sendDeliveryReceipt(client, message.messageId, 'rejected',
      record.answered ? 'This question was already answered in Codex.' : 'This question has expired. Open Codex.',
      record.sessionId, peerPublicKey);
    await resolveQuestion(client, record, peerPublicKey, !record.answered);
    return true;
  }
  const hasAttachments = !!(message.attachments?.length || message.attachmentRefs?.length);
  if (!message.text.trim() || message.text.length > 4_000
    || (hasAttachments && message.questionReplyFormat !== 'attachments-v1')) return false;
  return deliver(client, { ...message, requestId: undefined,
    messageId: message.messageId ?? 'codex-answer-' + record.requestId,
    text: nativeAnswerEnvelope(record, message.text) }, publish, peerPublicKey,
  { messageId: record.requestId, nativeOnly: true });
}

function resolveQuestion(client: RelayClient, record: QuestionRecord, peerPublicKey?: string, expired = false) {
  return client.send({ type: 'approval.resolved', requestId: record.requestId,
    sessionId: record.sessionId, status: expired ? 'expired' : 'applied',
    nativeUiCleared: record.answered === true, resolvedAt: Date.now() },
  'phone', { ttlMs: 15 * 60_000, wake: false, peerPublicKey });
}
