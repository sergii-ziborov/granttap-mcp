import type { TaskDispatch } from '../../../../packages/protocol/schema';
import type { TaskOriginRegistry } from './index';

export function resolveTaskOriginJob(registry: TaskOriginRegistry, job: TaskDispatch,
  room: string, peerPublicKey: string): { state: string; job?: TaskDispatch } {
  if (job.operation.type !== 'user.message.continue') return { state: 'ready', job };
  const origin = registry.lookup({ room, peerPublicKey, originMessageId: job.operation.originMessageId },
    job.operation.agent, job.operation.projectId);
  if (origin.state !== 'ready') return { state: origin.state };
  const { originMessageId: _origin, type: _type, ...message } = job.operation;
  return { state: 'ready', job: { ...job, sessionId: origin.sessionId,
    operation: { ...message, type: 'user.message', sessionId: origin.sessionId,
      projectId: origin.projectId } } };
}
