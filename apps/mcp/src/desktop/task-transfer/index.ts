import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from '../../../../bridge/src/config/runtime/paths';
import { observedComputerId } from '../../../../bridge/src/mesh/identity/computer';
import { readStoreState } from '../../../../bridge/src/mesh/store/state';
import { localTransferContinuations, type TransferContinuations } from '../../../../bridge/src/task-transfer';

const Request = z.object({ session_id: z.string().min(1).max(256), project_id: z.string().min(1).max(128),
  task_id: z.string().min(1).max(128), capsule_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** The local native client can confirm only an execution owned by this computer. */
export function desktopTransferContinue(input: unknown,
  options: { storePath?: string; computer?: string; continuations?: TransferContinuations } = {}): unknown {
  const parsed = Request.safeParse(input);
  if (!parsed.success) return undefined;
  const request = parsed.data;
  const loaded = readStoreState(options.storePath ?? join(configDir(), 'project-mesh.json'));
  if (loaded.status !== 'ok') return undefined;
  const own = loaded.state.executions.find(execution => execution.sessionId === request.session_id
    && execution.taskId === request.task_id && execution.computerId === (options.computer ?? observedComputerId()));
  const task = loaded.state.tasks.find(task => task.taskId === request.task_id && task.projectId === request.project_id);
  if (!own || !task) return undefined;
  const continuation = options.continuations ?? localTransferContinuations();
  const accepted = continuation.continue({ sessionId: request.session_id, projectId: request.project_id,
    taskId: request.task_id, capsuleHash: request.capsule_hash });
  return { operation: 'desktop.transfer_continue', accepted, notice: continuation.notice(request.session_id) };
}
