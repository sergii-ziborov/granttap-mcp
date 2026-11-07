import type { DeliveryOptions, ReplyResult } from '../../reply/payload/types';
import { DesktopReceipt } from '../receipts';

/** Called inside the chat queue only after desktop discovery proves no owner exists. */
export async function continueCodexQuestion(sessionId: string, options: DeliveryOptions,
  run: () => Promise<ReplyResult>): Promise<ReplyResult> {
  if (!options.messageId || !options.intentDigest) {
    return { ok: false, error: 'The question answer has no stable delivery identity.' };
  }
  try {
    // Share the native admission journal: neither a second controller nor a
    // later desktop owner may submit another answer for this question.
    const receipt = new DesktopReceipt(sessionId, options.messageId, options.intentDigest);
    const state = receipt.begin();
    if (state === 'accepted') return { ok: true, text: '', sessionId, delivery: 'native' };
    if (state === 'conflict') return { ok: false, error: 'This message ID belongs to a different Codex delivery.' };
    if (state !== 'new') return uncertain();
    const result = await run();
    if (!result.ok) return { ...result, delivery: 'native' };
    receipt.accept('cli:' + sessionId);
    return result;
  } catch { return uncertain(); }
}

function uncertain(): ReplyResult {
  return { ok: false, delivery: 'native',
    error: 'Codex has not confirmed this answer. Check the original chat before sending it again.' };
}
