import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MeshEvent,
  MeshEventPayload,
  MeshEventType,
} from "../../../../../packages/protocol/schema";
import { classifyHumanAttention } from "../../../../bridge/src/mesh/tasks/attention";
import {
  executionCapabilityFor,
  liveExecutionScope,
  resolveExecutionCapability,
  type ExecutionCapability,
} from "../../../../bridge/src/mesh/catalog/capability";
import { consumeAttributedCall } from "../../../../bridge/src/mesh/identity/call-scope";
import { localMeshStore } from "../../../../bridge/src/mesh/local-remote/local";
import { handleMeshPayload } from "../../../../bridge/src/mesh/runtime";
import { sendMeshPayload } from "../../../../bridge/src/host/session-keys";
import { isMeshEnabled, isProviderEnabled } from "../../../../bridge/src/config/runtime";
import { sessionFromEnvironment } from "../mesh/resource";
import { STORE_BUSY, UNATTRIBUTED } from "./answers";
import {
  relay,
  type TaskInteractionScope,
} from "../connect/relay";

export const meshEventInput = z.object({
  capability: z.string().trim().min(1).max(128).optional(),
  projectId: z.string().trim().min(1).max(128),
  taskId: z.string().trim().min(1).max(128),
  sourceSessionId: z.string().trim().min(1).max(128).optional(),
  targetSessionId: z.string().trim().min(1).max(128).optional(),
  eventType: MeshEventType,
  payload: MeshEventPayload,
  expiresInSeconds: z.number().int().min(30).max(86_400).optional(),
}).strict();

function callerScope(
  input: z.infer<typeof meshEventInput>,
  attributedSessionId: string | undefined,
): ExecutionCapability {
  const capability = attributedSessionId
    ? executionCapabilityFor(attributedSessionId)
    : resolveExecutionCapability(input.capability);
  if (!capability) {
    throw new Error(attributedSessionId || input.capability
      ? "Mesh caller is not a live execution of an enabled coding agent"
      : UNATTRIBUTED);
  }
  if (input.capability && input.capability !== capability.token) {
    throw new Error("Mesh capability belongs to a different execution");
  }
  if (input.sourceSessionId && input.sourceSessionId !== capability.sessionId) {
    throw new Error("Mesh events are published only for the calling execution");
  }
  if (input.projectId !== capability.projectId || input.taskId !== capability.taskId) {
    throw new Error("Mesh Task is outside this execution's scope");
  }
  if (!capability.allowedEventTypes.includes(input.eventType)) {
    throw new Error(`${input.eventType} is decided by GrantTap, not by a tool call`);
  }
  return capability;
}

type Published = {
  status: "published" | "claim_rejected";
  eventId: string;
  text: string;
  conflict?: { ownerSessionId: string; resource: string };
};

export async function publishMeshEvent(
  client: NonNullable<Awaited<ReturnType<typeof relay>>>,
  input: z.infer<typeof meshEventInput>,
  attributedSessionId?: string,
): Promise<Published> {
  if (!isMeshEnabled()) throw new Error("Project Mesh is disabled");
  const scope = callerScope(input, attributedSessionId);
  const source = { provider: scope.provider, sessionId: scope.sessionId };
  if (!isProviderEnabled(source.provider)) {
    throw new Error("Mesh source session is not an enabled Task execution");
  }
  const now = Date.now();
  const event = MeshEvent.parse({
    type: "mesh.event",
    sessionId: input.taskId,
    eventId: randomUUID(),
    projectId: input.projectId,
    taskId: input.taskId,
    sourceSessionId: source.sessionId,
    targetSessionId: input.targetSessionId,
    eventType: input.eventType,
    createdAt: now,
    expiresAt: now + (input.expiresInSeconds ?? 3_600) * 1_000,
    payload: input.payload,
  });
  const ttlMs = (input.expiresInSeconds ?? 3_600) * 1_000;
  if (event.eventType === "RESOURCE_CLAIM" && event.payload.claim) {
    const claim = event.payload.claim;
    const result = localMeshStore().acceptClaimEvent(event);
    if (!result.applied) throw new Error(STORE_BUSY);
    if (result.conflict) {
      const conflict = result.conflict;
      const collision = MeshEvent.parse({
        ...event,
        eventId: randomUUID(),
        targetSessionId: conflict.ownerSessionId,
        eventType: "CONFLICT",
        payload: {
          resource: claim.resource,
          otherOwnerSessionId: conflict.ownerSessionId,
          reason: `${conflict.ownerSessionId} currently claims ${conflict.resource}`,
          resolved: false,
          needsUser: false,
        },
      });
      await handleMeshPayload(client, collision, "agent");
      await sendMeshPayload(client, collision, "phone", { ttlMs });
      return {
        status: "claim_rejected",
        eventId: collision.eventId,
        text: `claim rejected: ${conflict.ownerSessionId} owns ${conflict.resource}; coordinate before editing`,
        conflict: { ownerSessionId: conflict.ownerSessionId, resource: conflict.resource },
      };
    }
    await sendMeshPayload(client, event, "phone", { ttlMs });
    return { status: "published", eventId: event.eventId, text: "mesh event published" };
  }
  await handleMeshPayload(client, event, "agent");
  const wake = classifyHumanAttention(event.eventType, event.payload);
  await sendMeshPayload(client, event, "phone", { ttlMs, wake: wake || undefined });
  localMeshStore();
  return { status: "published", eventId: event.eventId, text: "mesh event published" };
}

export function interactionScope(
  tool: "ask" | "ask_yes_no",
  text: string,
  operation?: string,
): TaskInteractionScope | undefined {
  const attributed = consumeAttributedCall(
    tool, { question: text, operationId: operation }, Date.now(), sessionFromEnvironment(),
  );
  if (!attributed) return undefined;
  const live = liveExecutionScope(attributed.sessionId);
  if (!live || live.execution.provider !== attributed.provider) return undefined;
  return {
    provider: attributed.provider,
    sessionId: attributed.sessionId,
    projectId: live.snapshot.projectId,
    taskId: live.execution.taskId,
    computerId: live.execution.computerId,
  };
}
