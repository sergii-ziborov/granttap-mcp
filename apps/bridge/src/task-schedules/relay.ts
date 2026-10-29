import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { RelayClient } from '../../../../packages/core/relay-client';
import { TaskSchedulesRequest } from '../../../../packages/protocol/task-schedules';
import { configDir, loadConfig, machineConfigPath } from '../config';
import { publishedCatalog, publishedSession } from '../session-catalog';
import { sendSessionPayload } from '../host/session-keys';
import { createTaskScheduleRepository } from '.';
import { TaskScheduleControls } from './controls';

let current: { root: string; controls: TaskScheduleControls } | undefined;

/** Task scope comes from admitted executions. Native paths and peer identity are never phone supplied. */
export async function handleTaskSchedules(client: RelayClient, input: TaskSchedulesRequest,
  peer: string | undefined): Promise<boolean> {
  const parsed = TaskSchedulesRequest.safeParse(input);
  if (!peer || !parsed.success || Math.abs(Date.now() - parsed.data.createdAt) > 120_000) return false;
  const request = parsed.data;
  try {
    const machine = loadConfig(machineConfigPath());
    if (machine.role !== 'machine' || machine.room !== client.room
      || machine.peerPublicKey !== peer && !machine.extraPeerPublicKeys?.includes(peer)) return false;
  } catch { return false; }
  const session = publishedSession(client, request.sessionId);
  if (!session) return false;
  const catalog = publishedCatalog(client);
  const candidates = [...(catalog?.sessions ?? []), ...(catalog?.history ?? [])];
  const sessions = [...new Set(candidates.filter(item => item.agent === 'codex'
    && (item.sessionId === session.sessionId || session.projectId != null && session.taskId != null
      && item.projectId === session.projectId && item.taskId === session.taskId)).map(item => item.sessionId))];
  const root = process.env.GRANTTAP_CODEX_DIR ?? process.env.NODVOX_CODEX_DIR ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  if (!isAbsolute(root)) return false;
  if (current?.root !== root) current = { root, controls: new TaskScheduleControls(createTaskScheduleRepository({
    root, backupRoot: join(configDir(), 'task-schedule-checkpoints'),
  })) };
  return current.controls.handle(request, { controller: JSON.stringify([client.room, peer]), sessions,
    send: result => sendSessionPayload(client, result, request.sessionId, 'phone', {
      peerPublicKey: peer, reliable: false, urgent: true, ttlMs: 30_000,
    }),
  });
}
