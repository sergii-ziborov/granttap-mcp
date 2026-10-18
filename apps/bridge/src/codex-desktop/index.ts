import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SessionInfo } from '../../../../packages/protocol/schema';
import { loadRuntimeConfig } from '../config';
import type { DeliveryOptions, ReplyResult } from '../reply';
import { DesktopConnection } from './connection';
import { DesktopReceipt } from './receipts';
import { desktopSocketPath } from './socket-path';
export { interruptCodexDesktop } from './controls';

const UNAVAILABLE = 'Codex desktop is not ready to receive this message. Keep the original chat open and try again.';
const UNCERTAIN = 'Codex has not confirmed this message. Check the original chat before sending it again.';

/** Undefined means no desktop owner exists; only then may the caller resume a CLI. */
export async function deliverToCodexDesktop(input: {
  session: SessionInfo; text: string; images: string[]; options: DeliveryOptions; timeoutMs: number;
}): Promise<ReplyResult | undefined> {
  let connection: DesktopConnection | undefined;
  let dispatched = false;
  const { session, text, images, options } = input;
  const accepted: ReplyResult = { ok: true, text: '', sessionId: session.sessionId, delivery: 'native' };
  try {
    const policy = loadRuntimeConfig();
    const request = turnRequest(input, policy.sessionAccess[session.sessionId]);
    const intent = options.intentDigest ?? { text,
      images: images.map(path => createHash('sha256').update(readFileSync(path)).digest('hex')), options };
    const receipt = new DesktopReceipt(session.sessionId, request.clientUserMessageId, intent);
    const prior = receipt.lookup();
    if (prior === 'accepted') return accepted;
    if (prior) return refusal(prior);
    const path = desktopSocketPath();
    if (!path) return undefined;
    connection = new DesktopConnection(path, input.timeoutMs);
    await connection.initialize();
    const owner = await connection.call('thread-owner-discovery',
      { hostId: 'local', conversationId: session.sessionId }, 1);
    if (owner.resultType === 'error' && owner.error === 'no-client-found') return undefined;
    if (owner.resultType !== 'success' || !owner.handledByClientId) return { ok: false, error: UNAVAILABLE };
    if (policy.sessionMcpDisabled[session.sessionId]?.length) {
      return { ok: false, error: 'Apply this Task’s disabled MCP settings in Codex before continuing its open desktop chat.' };
    }
    const state = receipt.begin();
    if (state === 'accepted') return accepted;
    if (state !== 'new') return refusal(state);
    dispatched = true;
    const response = await connection.call('thread-follower-start-turn', {
      conversationId: session.sessionId,
      turnStart: { request, context: { inheritThreadSettings: true } },
    }, 2, owner.handledByClientId);
    const turnId = response.result?.result?.turn?.id;
    if (response.resultType !== 'success' || typeof turnId !== 'string' || !turnId || turnId.length > 180) {
      return { ok: false, error: UNCERTAIN, delivery: 'native' };
    }
    receipt.accept(turnId);
    return accepted;
  } catch {
    return { ok: false, error: dispatched ? UNCERTAIN : UNAVAILABLE,
      ...(dispatched ? { delivery: 'native' as const } : {}) };
  } finally { connection?.close(); }
}

function refusal(state: string): ReplyResult {
  return state === 'conflict' ? { ok: false, error: 'This message ID belongs to a different Codex delivery.' }
    : { ok: false, error: UNCERTAIN, delivery: 'native' };
}

function turnRequest(input: { session: SessionInfo; text: string; images: string[]; options: DeliveryOptions }, access?: string) {
  const { session, text, images, options } = input;
  const effort = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.effort ?? '') ? options.effort : undefined;
  const sandboxPolicy = access === 'read-only' ? { type: 'readOnly', networkAccess: false }
    : access === 'workspace' ? { type: 'workspaceWrite', writableRoots: session.cwd ? [session.cwd] : [],
      networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    : access === 'full' ? { type: 'dangerFullAccess' } : undefined;
  return { threadId: session.sessionId, clientUserMessageId: options.messageId ?? randomUUID(),
    input: [{ type: 'text', text, text_elements: [] }, ...images.map(path => ({ type: 'localImage', path }))],
    ...(options.model ? { model: options.model } : {}), ...(effort ? { effort } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}) };
}
