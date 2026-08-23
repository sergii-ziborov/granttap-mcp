import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MeshEvent,
  MeshEventPayload,
  MeshEventType,
} from "../../../../packages/protocol/schema";
import { classifyHumanAttention } from "../../../bridge/src/mesh/attention";
import { localMeshStore } from "../../../bridge/src/mesh/local";
import { handleMeshPayload } from "../../../bridge/src/mesh/runtime";
import { sendMeshPayload } from "../../../bridge/src/session-keys";
import { isMeshEnabled, isProviderEnabled } from "../../../bridge/src/config/runtime";
import { askOpenQuestion, askYesNo, relay } from "./relay";

const NOT_PAIRED =
  "GrantTap is not paired on this machine. Pair the desktop bridge with the GrantTap app first.";
const question = z.string().min(1).max(8_000).describe("The question to ask");
const meshEventInput = z.object({
  projectId: z.string().trim().min(1).max(128),
  taskId: z.string().trim().min(1).max(128),
  sourceSessionId: z.string().trim().min(1).max(128),
  targetSessionId: z.string().trim().min(1).max(128).optional(),
  eventType: MeshEventType,
  payload: MeshEventPayload,
  expiresInSeconds: z.number().int().min(30).max(86_400).optional(),
}).strict();

export function registerInteractionTools(server: McpServer): void {
  server.registerTool(
    "notify",
    {
      description: "Send a non-blocking user status, or publish one bounded task-scoped Project Mesh event.",
      inputSchema: {
        message: z.string().min(1).max(2_000).describe("Optional text to show on the user's devices").optional(),
        meshEvent: meshEventInput.describe("Optional structured coordination event; never include hidden reasoning").optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ message, meshEvent }) => {
      if (!message && !meshEvent) return {
        isError: true,
        content: [{ type: "text" as const, text: "Provide message or meshEvent." }],
      };
      const client = await relay();
      if (!client) return notPaired();
      if (message) {
        await client.send(
          { type: "agent.event", text: message, kind: "status", createdAt: Date.now() },
          "phone",
          { ttlMs: 15 * 60_000, wake: true },
        );
      }
      const result = meshEvent ? await publishMeshEvent(client, meshEvent) : "sent to phone";
      return { content: [{ type: "text", text: result }] };
    },
  );
  server.registerTool(
    "ask_yes_no",
    {
      description: "Ask the user a yes/no question on their phone/watch and wait for the tap. Returns 'yes' or 'no'.",
      inputSchema: { question: question.describe("A question answerable with yes/no") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ question: text }) => answerYesNo(text),
  );
  server.registerTool(
    "ask",
    {
      description: "Ask the user an open question on their phone/watch and wait for their spoken or typed reply. Returns their answer text.",
      inputSchema: { question },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ question: text }) => answerOpenQuestion(text),
  );
}

async function publishMeshEvent(
  client: NonNullable<Awaited<ReturnType<typeof relay>>>,
  input: z.infer<typeof meshEventInput>,
): Promise<string> {
  if (!isMeshEnabled()) throw new Error("Project Mesh is disabled");
  const snapshot = localMeshStore().snapshot(input.projectId);
  const source = snapshot?.executions.find((execution) =>
    execution.taskId === input.taskId
    && execution.sessionId === input.sourceSessionId
    && execution.endedAt == null);
  if (!source || source.provider === "grok_bot" || !isProviderEnabled(source.provider)) {
    throw new Error("Mesh source session is not an enabled Task execution");
  }
  const now = Date.now();
  const event = MeshEvent.parse({
    type: "mesh.event",
    sessionId: input.taskId,
    eventId: randomUUID(),
    projectId: input.projectId,
    taskId: input.taskId,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    eventType: input.eventType,
    createdAt: now,
    expiresAt: now + (input.expiresInSeconds ?? 3_600) * 1_000,
    payload: input.payload,
  });
  const claim = event.eventType === "RESOURCE_CLAIM" ? event.payload.claim : undefined;
  const conflict = claim
    ? localMeshStore().conflicts(event.projectId, event.sourceSessionId, claim.resource).at(0)
    : undefined;
  if (claim && conflict) {
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
    await handleMeshPayload(client, collision);
    await sendMeshPayload(client, collision, "phone", {
      ttlMs: (input.expiresInSeconds ?? 3_600) * 1_000,
    });
    return `claim rejected: ${conflict.ownerSessionId} owns ${conflict.resource}; coordinate before editing`;
  }
  await handleMeshPayload(client, event);
  const wake = classifyHumanAttention(event.eventType, event.payload);
  await sendMeshPayload(client, event, "phone", {
    ttlMs: (input.expiresInSeconds ?? 3_600) * 1_000,
    wake: wake || undefined,
  });
  // Keep the shared singleton warm for the MCP resource even when the monitor
  // has not yet completed its first provider scan.
  localMeshStore();
  return "mesh event published";
}

function notPaired() {
  return { content: [{ type: "text" as const, text: NOT_PAIRED }] };
}

async function answerYesNo(questionText: string) {
  const client = await relay();
  if (!client) return notPaired();
  return { content: [{ type: "text" as const, text: await askYesNo(client, questionText) }] };
}

async function answerOpenQuestion(questionText: string) {
  const client = await relay();
  if (!client) return notPaired();
  return { content: [{ type: "text" as const, text: await askOpenQuestion(client, questionText) }] };
}
