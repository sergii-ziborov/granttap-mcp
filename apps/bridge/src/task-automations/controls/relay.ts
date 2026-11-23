import type { RelayClient } from '../../../../../packages/core/relay-client';
import { CodingAgent, TaskAutomationsRequest } from '../../../../../packages/protocol/schema';
import { loadConfig, machineConfigPath } from '../../config';
import { sendSessionPayload } from '../../host/session-keys';
import { publishedCatalog, publishedSession } from '../../session-catalog';
import { TaskAutomationControls, type AutomationScope } from '.';

let controls: TaskAutomationControls | undefined;
let changed: () => void = () => {};

/** The monitor's runner looks again as soon as a phone changed an automation, rather than at its next pass. */
export function onAutomationsChanged(listener: (() => void) | undefined): void { changed = listener ?? (() => {}); }

/** For tests: a control set with its own clock and store. */
export function useAutomationControls(value: TaskAutomationControls | undefined): void { controls = value; }

/**
 * `task.automations` from a paired phone. The chat must be one this computer published; its scope is
 * the chats of its Task here. Paths, agents and Task identity come from the catalog, never the phone.
 * The answer goes only to that phone, under the chat's key, ahead of snapshots.
 */
export async function handleTaskAutomations(client: RelayClient, input: TaskAutomationsRequest,
  peer: string | undefined): Promise<boolean> {
  const parsed = TaskAutomationsRequest.safeParse(input);
  if (!peer || !parsed.success || Math.abs(Date.now() - parsed.data.createdAt) > 120_000) return false;
  const request = parsed.data;
  try {
    const machine = loadConfig(machineConfigPath());
    if (machine.role !== 'machine' || machine.room !== client.room
      || machine.peerPublicKey !== peer && !machine.extraPeerPublicKeys?.includes(peer)) return false;
  } catch { return false; }
  const session = publishedSession(client, request.sessionId), agent = CodingAgent.safeParse(session?.agent);
  if (!session || !agent.success) return false;
  const catalog = publishedCatalog(client);
  const sessions = [...new Set([session.sessionId, ...[...(catalog?.sessions ?? []), ...(catalog?.history ?? [])]
    .filter(item => session.projectId != null && session.taskId != null
      && item.projectId === session.projectId && item.taskId === session.taskId).map(item => item.sessionId)])];
  const scope: AutomationScope = { sessions, chat: { sessionId: session.sessionId, agent: agent.data,
    ...(session.projectId ? { projectId: session.projectId } : {}), ...(session.taskId ? { taskId: session.taskId } : {}) } };
  controls ??= new TaskAutomationControls({ changed: () => changed() });
  return controls.handle(request, { controller: JSON.stringify([client.room, peer]), scope,
    send: result => sendSessionPayload(client, result, request.sessionId, 'phone', {
      peerPublicKey: peer, reliable: false, urgent: true, ttlMs: 30_000,
    }),
  });
}
