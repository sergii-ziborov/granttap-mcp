import type { RelayClient } from '../../../../../packages/core/relay-client';
import type { MeshHandoffPrepare, TaskTransferContinue } from '../../../../../packages/protocol/schema';
import { prepareMeshHandoff } from '../../mesh/runtime';
import { handleTransferContinuation } from './continuation';

export async function handleTaskTransferCommand(client: RelayClient,
  command: MeshHandoffPrepare | TaskTransferContinue, onAccepted: () => void): Promise<boolean> {
  if (command.type === 'task.transfer.continue') return handleTransferContinuation(client, command, onAccepted);
  const accepted = await prepareMeshHandoff(client, command);
  if (accepted) onAccepted();
  return accepted;
}
