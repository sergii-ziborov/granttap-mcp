import { join } from 'node:path';
import { z } from 'zod';
import { configDir, loadConfig, loadRuntimeConfig, machineConfigPath } from '../../../../bridge/src/config';
import { computerId } from '../../../../bridge/src/mesh/identity/computer';
import { readStoreState } from '../../../../bridge/src/mesh/store/state';
import { NativeTaskQueueSender } from '../../../../bridge/src/task-dispatch';
import { CodingAgent, UserMessage } from '../../../../../packages/protocol/schema';
import { readDesktopAttachments } from '../delivery/attachments';

const Query = z.object({ action: z.enum(['put', 'status', 'cancel']),
  project_id: z.string().min(1).max(180), task_id: z.string().min(1).max(180),
  session_id: z.string().min(1).max(180), delivery_id: z.string().uuid(),
  text: z.string().max(8_000).optional(), model: z.string().min(1).max(120).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  not_before: z.number().int().nonnegative().optional(), created_at: z.number().int().nonnegative().optional(),
  attachments_json: z.string().max(32_768).optional(), preferred_mcp: z.string().max(180).optional(),
  skill: z.string().max(180).optional(), permission_mode: z.string().max(80).optional(),
}).strict();

type Sender = Pick<NativeTaskQueueSender, 'submit' | 'status' | 'cancel'>;
export async function desktopTaskQueue(input: unknown, options: {
  storePath?: string; endpointId?: string; sender?: Sender;
  providerEnabled?: (provider: CodingAgent) => boolean;
} = {}): Promise<unknown> {
  const parsed = Query.safeParse(input);
  if (!parsed.success) return undefined;
  const query = parsed.data;
  const loaded = readStoreState(options.storePath ?? join(configDir(), 'project-mesh.json'));
  if (loaded.status !== 'ok') return undefined;
  const task = loaded.state.tasks.find(row => row.taskId === query.task_id && row.projectId === query.project_id);
  const execution = loaded.state.executions.find(row => row.taskId === task?.taskId
    && row.sessionId === query.session_id && row.computerId === (options.endpointId ?? computerId()));
  const provider = CodingAgent.safeParse(execution?.provider);
  if (!task || !execution?.workspace || !provider.success) return undefined;
  const scope = { projectId: task.projectId, taskId: task.taskId, sessionId: execution.sessionId, provider: provider.data };
  try {
    const sender = options.sender ?? new NativeTaskQueueSender({ root: join(configDir(), 'native-task-queue'),
      config: loadConfig(machineConfigPath()) });
    let job;
    if (query.action === 'put') {
      if ((options.providerEnabled?.(provider.data)
        ?? loadRuntimeConfig().providerSettings[provider.data] !== false) === false) {
        return { operation: 'desktop.task_queue', accepted: false, error: 'This provider is disabled on this computer.' };
      }
      if (query.text === undefined || query.created_at === undefined || query.not_before === undefined) return undefined;
      const attachments = readDesktopAttachments(query.attachments_json);
      if (!attachments) return undefined;
      const message = UserMessage.safeParse({ type: 'user.message', messageId: query.delivery_id,
        sessionId: execution.sessionId, projectId: task.projectId, agent: provider.data,
        text: query.text, attachments, model: query.model, effort: query.effort,
        preferredMcp: query.preferred_mcp, skill: query.skill, permissionMode: query.permission_mode,
        createdAt: query.created_at });
      if (!message.success) return undefined;
      job = await sender.submit(scope, message.data, query.not_before, query.created_at);
    } else {
      job = await sender[query.action](scope, query.delivery_id);
    }
    return { operation: 'desktop.task_queue', accepted: true, job, error: null };
  } catch {
    return { operation: 'desktop.task_queue', accepted: false,
      error: 'The relay has not confirmed this queue change. Check the connection or queue status.' };
  }
}
