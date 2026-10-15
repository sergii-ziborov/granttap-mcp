import type { RelayClient } from '../../../../../packages/core/relay-client';
import type { TaskTransferContinue } from '../../../../../packages/protocol/schema';
import { sendSessionPayload } from '../../host/session-keys';
import { localTransferContinuations } from '../continuation';

export async function handleTransferContinuation(client: RelayClient, command: TaskTransferContinue, onAccepted?: () => void): Promise<boolean> {
  const store = localTransferContinuations();
  const age = Date.now() - command.createdAt;
  const accepted = age >= -300_000 && age <= 86_400_000 && store.continue(command);
  await sendSessionPayload(client, { ...command, type: 'task.transfer.continued', accepted,
    notice: store.notice(command.sessionId), createdAt: Date.now() }, command.sessionId, 'phone', { ttlMs: 86_400_000 });
  if (accepted) onAccepted?.();
  return accepted;
}
