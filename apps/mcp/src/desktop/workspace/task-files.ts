import { join } from 'node:path';
import { configDir } from '../../../../bridge/src/config';
import { readStoreState } from '../../../../bridge/src/mesh/store/state';
import { readTaskWorkspace } from '../../../../bridge/src/task-files';
import type { SessionInfo } from '../../../../../packages/protocol/schema';
/** Native desktop requests must match the Task's recorded execution exactly. */
export function desktopTaskWorkspace(input: unknown, storePath = join(configDir(), 'project-mesh.json')) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return undefined;
    const query = input as Record<string, unknown>;
    const { project_id: projectId, task_id: taskId, session_id: sessionId, mode, path, offset } = query;
    if (typeof projectId !== 'string' || typeof taskId !== 'string' || typeof sessionId !== 'string'
        || !['directory', 'file'].includes(String(mode)) || typeof path !== 'string' || path.length > 4096
        || offset !== undefined && (!Number.isSafeInteger(offset) || Number(offset) < 0))
        return undefined;
    const loaded = readStoreState(storePath);
    if (loaded.status !== 'ok')
        return undefined;
    const tasks = loaded.state.tasks.filter(t => t.taskId === taskId);
    if (tasks.length !== 1 || tasks[0]?.projectId !== projectId)
        return undefined;
    const executions = loaded.state.executions.filter(e => e.taskId === taskId && e.sessionId === sessionId);
    if (executions.length !== 1)
        return undefined;
    const execution = executions[0]!;
    const session: SessionInfo = { sessionId, agent: execution.provider, cwd: execution.workspace,
        state: 'idle', startedAt: execution.startedAt, lastActivityAt: execution.updatedAt ?? execution.startedAt, tokensSession: 0, tokensLastTurn: 0 };
    const result = readTaskWorkspace(session, { mode: mode as 'directory' | 'file', path, offset: offset as number | undefined });
    return result ? { operation: 'desktop.task_workspace', ...result } : undefined;
}
