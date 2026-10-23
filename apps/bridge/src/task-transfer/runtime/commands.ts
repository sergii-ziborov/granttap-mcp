import type { RelayClient } from '../../../../../packages/core/relay-client';
import type { MeshHandoffPrepare, TaskTransferContinue } from '../../../../../packages/protocol/schema';
import { prepareMeshHandoff } from '../../mesh/runtime';
import { handleTransferContinuation } from './continuation';

export async function handleTaskTransferCommand(client: RelayClient,
  command: MeshHandoffPrepare | TaskTransferContinue, publish: () => void,
  prepare = prepareMeshHandoff): Promise<boolean> {
  if (command.type === 'task.transfer.continue') return handleTransferContinuation(client, command, publish);
  // Rejections are durable state too. Publish them even if the direct result
  // could not cross the socket, so reconnecting controllers can explain them.
  try { return await prepare(client, command); }
  finally { publish(); }
}
