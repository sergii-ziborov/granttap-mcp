import { z } from 'zod';
import { MeshEvent } from '../messages/mesh/events';
import { ExecutionSessionLink, MeshTask } from '../messages/mesh/tasks';
import { UserAttachment } from '../messages/interaction';
import { TaskRoutingNeeds } from '../task-resources';

const id = z.string().min(1).max(128);
const writerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const publicKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const relayURL = z.string().max(2_048).url().refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash
    && (['https:', 'wss:'].includes(url.protocol)
      || ['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
});

export const TaskNetworkPeer = z.object({ endpointId: id, publicKey,
  incomingWriterId: writerId,
  outgoing: z.object({ relayUrl: relayURL, room: z.string().regex(/^[a-f0-9]{16,64}$/),
    writerId, secret: digest, scopeHash: digest, expiresAt: stamp }).strict(),
}).strict();
export type TaskNetworkPeer = z.infer<typeof TaskNetworkPeer>;

export const ProjectTransportSet = z.object({ type: z.literal('project.transport.set'),
  sessionId: id, projectId: id, targetEndpointId: id, requestId: id,
  revision: z.number().int().nonnegative(), enabled: z.boolean(), expiresAt: stamp,
  routingEnabled: z.boolean().default(false),
  createdAt: stamp,
  allowCrossPlatform: z.boolean(), cooldownMs: z.number().int().min(60_000).max(86_400_000),
  peers: z.array(TaskNetworkPeer).max(16),
}).strict().superRefine((value, context) => {
  if (value.sessionId !== value.projectId || !value.enabled && value.peers.length
    || new Set(value.peers.map(peer => peer.endpointId)).size !== value.peers.length
    || new Set(value.peers.map(peer => peer.incomingWriterId)).size !== value.peers.length
    || value.peers.some(peer => peer.endpointId === value.targetEndpointId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Project peer scope' });
  }
});
export type ProjectTransportSet = z.infer<typeof ProjectTransportSet>;

export const ProjectTransportAck = z.object({ type: z.literal('project.transport.ack'),
  sessionId: id, projectId: id, targetEndpointId: id, requestId: id,
  revision: z.number().int().nonnegative(), accepted: z.boolean(), generatedAt: stamp,
}).strict();

export const PeerTaskTransfer = z.object({ type: z.literal('mesh.task.transfer'),
  projectId: id, taskId: id, policyRevision: z.number().int().nonnegative(),
  automatic: z.literal(true).optional(),
  routing: TaskRoutingNeeds.extend({ sourceOS: z.enum(['darwin', 'linux', 'win32']),
    sourceArchitecture: z.string().min(1).max(32) }).strict().optional(),
  task: MeshTask, sourceExecution: ExecutionSessionLink, event: MeshEvent,
  forward: z.object({ text: z.string().min(1).max(32_000),
    attachments: z.array(UserAttachment).max(8).optional(), model: z.string().max(200).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional() }).strict().optional(),
}).strict().superRefine((value, context) => {
  const capsule = value.event.payload.capsule;
  if (value.task.projectId !== value.projectId || value.task.taskId !== value.taskId
    || value.sourceExecution.taskId !== value.taskId || value.event.projectId !== value.projectId
    || value.event.taskId !== value.taskId || value.event.eventType !== 'HANDOFF_REQUEST'
    || value.event.sourceSessionId !== value.sourceExecution.sessionId
    || capsule?.launch !== 'on_message' || !value.event.payload.transferContext
    || capsule.sourceComputer !== value.sourceExecution.computerId
    || capsule.sourceProvider !== value.sourceExecution.provider || Boolean(value.automatic) !== Boolean(value.routing)
    || value.automatic && (capsule.targetProvider === 'grok_bot' || capsule.targetProvider !== value.sourceExecution.provider || !value.forward
      || !capsule.targetModel || value.forward.model !== capsule.targetModel
      || capsule.targetProvider !== 'cursor' && !value.forward.effort)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid transferred Task scope' });
  }
});
export type PeerTaskTransfer = z.infer<typeof PeerTaskTransfer>;

/** Dedicated peer queue lane. It grants no ordinary phone/controller message access. */
export const PeerTaskDispatch = z.object({ type: z.literal('mesh.task.dispatch'),
  jobId: writerId, token: digest, notBefore: stamp, expiresAt: stamp, createdAt: stamp,
  operation: PeerTaskTransfer,
}).strict().refine(value => value.expiresAt > value.notBefore && value.notBefore >= value.createdAt - 300_000
  && value.expiresAt - value.createdAt <= 30 * 86_400_000)
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 16_000_000,
    'The complete transfer exceeds the encrypted transport bound.');
export type PeerTaskDispatch = z.infer<typeof PeerTaskDispatch>;

export const PeerTaskResult = z.object({ type: z.literal('mesh.task.result'),
  jobId: writerId, projectId: id, taskId: id, event: MeshEvent,
  destination: ExecutionSessionLink.optional(),
}).strict().refine(value => value.event.projectId === value.projectId
  && value.event.taskId === value.taskId && ['HANDOFF_ACCEPTED', 'HANDOFF_REJECTED'].includes(value.event.eventType)
  && (!value.destination || value.event.eventType === 'HANDOFF_ACCEPTED'
    && value.destination.taskId === value.taskId
    && value.destination.sessionId === value.event.payload.receipt?.targetSessionId));
export type PeerTaskResult = z.infer<typeof PeerTaskResult>;
