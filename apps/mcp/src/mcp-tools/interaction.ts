import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MeshEvent,
  MeshEventPayload,
  MeshEventType,
} from "../../../../packages/protocol/schema";
import { classifyHumanAttention } from "../../../bridge/src/mesh/attention";
import {
  executionCapabilityFor,
  resolveExecutionCapability,
  type ExecutionCapability,
} from "../../../bridge/src/mesh/capability";
import { consumeAttributedCall } from "../../../bridge/src/mesh/call-scope";
import { liveExecutionScope } from "../../../bridge/src/mesh/capability";
import { localMeshStore } from "../../../bridge/src/mesh/local";
import { handleMeshPayload } from "../../../bridge/src/mesh/runtime";
import { sendMeshPayload } from "../../../bridge/src/session-keys";
import { isMeshEnabled, isProviderEnabled } from "../../../bridge/src/config/runtime";
import { sessionFromEnvironment } from "./mesh-resource";
import { OperationLedger, type OperationRecord } from "./operation-ledger";
import {
  askOpenQuestionOutcome,
  askYesNoOutcome,
  openAnswerText,
  relay,
  yesNoText,
  type TaskInteractionScope,
} from "./relay";

const NOT_PAIRED =
  "GrantTap is not paired on this machine. Pair the desktop bridge with the GrantTap app first.";
const question = z.string().min(1).max(8_000).describe("The question to ask");
const operationId = z.string().trim().min(1).max(128).optional().describe(
  "A name of your own for this call. Retrying with the same operationId repeats nothing that "
  + "already happened: an event is not published twice, a person is not asked twice, and only "
  + "the part that failed is done again.",
);
const meshEventInput = z.object({
  capability: z.string().trim().min(1).max(128).optional(),
  projectId: z.string().trim().min(1).max(128),
  taskId: z.string().trim().min(1).max(128),
  sourceSessionId: z.string().trim().min(1).max(128).optional(),
  targetSessionId: z.string().trim().min(1).max(128).optional(),
  eventType: MeshEventType,
  payload: MeshEventPayload,
  expiresInSeconds: z.number().int().min(30).max(86_400).optional(),
}).strict();

const UNATTRIBUTED =
  "GrantTap could not attribute this call to a live agent session. Project Mesh events "
  + "are published only for the execution that made the call, so its provider hook must "
  + "be installed and trusted (granttap setup).";

/** One ledger per server, which is one per chat: a retry from the same chat finds its record. */
const ledger = new OperationLedger();

/**
 * What a call came to, in a form a model can branch on.
 *
 * The text is what it always was, for a client that reads only text. The
 * structured result is the contract: a status that keeps "sent", "published"
 * and "refused" apart, a decision that is null when nobody answered, and the
 * id of a recorded event so a retry can be told from a duplicate. A call
 * that errors changed nothing; a call that changed something and then failed
 * says exactly which part is still owed.
 */
const notifyOutput = {
  status: z.enum(["sent", "published", "claim_rejected"]).describe(
    "sent: only a status text went to the phone; published: the Mesh event was recorded on this "
    + "computer and sent; claim_rejected: the claim conflicts with another execution's and was not recorded",
  ),
  messageSent: z.boolean().describe("Whether the status text was handed to the relay for the phone"),
  meshEventId: z.string().optional().describe("The id of the Mesh event as recorded (for claim_rejected, the CONFLICT event)"),
  conflict: z.object({
    ownerSessionId: z.string(),
    resource: z.string(),
  }).optional().describe("Who holds the resource this claim collided with"),
  scopedResource: z.string().optional().describe("This execution's scoped Mesh resource URI, when the call was attributed"),
  error: z.string().optional().describe("The part of the call that failed after the rest had happened; retry with the same operationId"),
  replayed: z.boolean().optional().describe("This answer repeats an earlier call with the same operationId"),
};
const yesNoOutput = {
  status: z.enum(["answered", "timed_out"]).describe("timed_out: nobody answered before the wait ended"),
  decision: z.enum(["yes", "no"]).nullable().describe("The person's answer; null when nobody answered. A timeout is not a refusal."),
  replayed: z.boolean().optional().describe("This answer repeats an earlier call with the same operationId"),
};
const openOutput = {
  status: z.enum(["answered", "timed_out"]).describe("timed_out: nobody answered before the wait ended"),
  answer: z.string().nullable().describe("The person's words; null when nobody answered"),
  replayed: z.boolean().optional().describe("This answer repeats an earlier call with the same operationId"),
};

function answered(text: string, outcome: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: outcome };
}

function replayed(record: OperationRecord) {
  return answered(`${record.text}\n(replayed: this operationId was already handled)`, { ...record.outcome, replayed: true });
}

export function registerInteractionTools(server: McpServer): void {
  server.registerTool(
    "notify",
    {
      description:
        "Send a non-blocking status to the user, or publish one bounded task-scoped Project Mesh event. "
        + "The result says whether the text was sent and whether the event was recorded; an error means nothing happened, "
        + "and a result with an error field says which part is still owed. Give the call an operationId to make retries safe. "
        + "A handoff is started by the person from the phone, never by an event published here.",
      inputSchema: {
        message: z.string().min(1).max(2_000).describe("Optional text to show on the user's devices").optional(),
        meshEvent: meshEventInput.describe("Optional structured coordination event; never include hidden reasoning").optional(),
        operationId,
      },
      outputSchema: notifyOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ message, meshEvent, operationId: operation }) => {
      if (!message && !meshEvent) return {
        isError: true,
        content: [{ type: "text" as const, text: "Provide message or meshEvent." }],
      };
      const client = await relay();
      if (!client) return notPaired();
      const previous = operation ? ledger.recall("notify", operation) : undefined;
      if (previous && (previous.pending !== "message" || !message)) return replayed(previous);
      let outcome: Record<string, unknown>;
      let text: string;
      let changedSomething = Boolean(previous);
      if (previous) {
        // The event went out last time; only the status text is still owed.
        outcome = { ...previous.outcome };
        text = previous.text;
      } else {
        // The provider hook already saw this exact call inside its own session.
        const attributed = consumeAttributedCall("notify", { message, meshEvent }, Date.now(), sessionFromEnvironment());
        // The event first: its checks can refuse the whole call, and a status
        // sent before a refusal would report work that did not happen.
        const published = meshEvent
          ? await publishMeshEvent(client, meshEvent, attributed?.sessionId)
          : undefined;
        changedSomething = published != null;
        const capability = isMeshEnabled() && attributed
          ? executionCapabilityFor(attributed.sessionId)
          : undefined;
        const scopedResource = capability ? `granttap://mesh/${capability.token}` : undefined;
        text = published?.text ?? "sent to phone";
        if (scopedResource) text = `${text}\nScoped Mesh state: ${scopedResource}`;
        outcome = {
          status: published?.status ?? "sent",
          messageSent: false,
          ...(published ? { meshEventId: published.eventId } : {}),
          ...(published?.conflict ? { conflict: published.conflict } : {}),
          ...(scopedResource ? { scopedResource } : {}),
        };
      }
      if (message) {
        try {
          await client.send(
            { type: "agent.event", text: message, kind: "status", createdAt: Date.now() },
            "phone",
            { ttlMs: 15 * 60_000, wake: true },
          );
          outcome.messageSent = true;
          delete outcome.error;
        } catch (error) {
          // Nothing else happened: the whole call failed, and says so.
          if (!changedSomething) throw error;
          const detail = error instanceof Error ? error.message : String(error);
          outcome.messageSent = false;
          outcome.error = `status text not sent: ${detail}`;
          const partial = `${text}\nStatus text not sent (${detail}). The Mesh event is recorded; `
            + "retry with the same operationId to send only the text.";
          if (operation) ledger.remember("notify", operation, { text, outcome, pending: "message" });
          return answered(partial, { ...outcome, ...(previous ? { replayed: true } : {}) });
        }
      }
      if (operation) ledger.remember("notify", operation, { text, outcome });
      return answered(text, { ...outcome, ...(previous ? { replayed: true } : {}) });
    },
  );
  server.registerTool(
    "ask_yes_no",
    {
      description:
        "Ask the user a yes/no question on their phone/watch and wait for the tap. Returns 'yes' or 'no' "
        + "when they answered, or 'no-answer (timeout)' when nobody answered in time. A timeout is not a "
        + "refusal: do not treat it as 'no', and do not treat it as permission. With an operationId, a retry "
        + "returns the answer already given instead of asking again.",
      inputSchema: { question: question.describe("A question answerable with yes/no"), operationId },
      outputSchema: yesNoOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ question: text, operationId: operation }) => {
      const previous = operation ? ledger.recall("ask_yes_no", operation) : undefined;
      if (previous) return replayed(previous);
      const result = await answerYesNo(text, interactionScope("ask_yes_no", text));
      if (operation && !result.isError && result.structuredContent) {
        ledger.remember("ask_yes_no", operation, { text: result.content[0]!.text, outcome: result.structuredContent });
      }
      return result;
    },
  );
  server.registerTool(
    "ask",
    {
      description:
        "Ask the user an open question on their phone/watch and wait for their spoken or typed reply. "
        + "Returns their answer text, or 'no-answer (timeout)' when nobody answered in time; a timeout is "
        + "not an answer. With an operationId, a retry returns the answer already given instead of asking again.",
      inputSchema: { question, operationId },
      outputSchema: openOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ question: text, operationId: operation }) => {
      const previous = operation ? ledger.recall("ask", operation) : undefined;
      if (previous) return replayed(previous);
      const result = await answerOpenQuestion(text, interactionScope("ask", text));
      if (operation && !result.isError && result.structuredContent) {
        ledger.remember("ask", operation, { text: result.content[0]!.text, outcome: result.structuredContent });
      }
      return result;
    },
  );
}

/**
 * Resolve the execution this call really belongs to.
 *
 * Nothing the model supplies can widen the scope: an attributed hook call wins,
 * a capability minted for another session is refused, and an unattributed call
 * without a capability publishes nothing.
 */
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

async function publishMeshEvent(
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
    await handleMeshPayload(client, collision, "agent");
    await sendMeshPayload(client, collision, "phone", {
      ttlMs: (input.expiresInSeconds ?? 3_600) * 1_000,
    });
    return {
      status: "claim_rejected",
      eventId: collision.eventId,
      text: `claim rejected: ${conflict.ownerSessionId} owns ${conflict.resource}; coordinate before editing`,
      conflict: { ownerSessionId: conflict.ownerSessionId, resource: conflict.resource },
    };
  }
  await handleMeshPayload(client, event, "agent");
  const wake = classifyHumanAttention(event.eventType, event.payload);
  await sendMeshPayload(client, event, "phone", {
    ttlMs: (input.expiresInSeconds ?? 3_600) * 1_000,
    wake: wake || undefined,
  });
  // Keep the shared singleton warm for the MCP resource even when the monitor
  // has not yet completed its first provider scan.
  localMeshStore();
  return { status: "published", eventId: event.eventId, text: "mesh event published" };
}

/** Not paired is an error, not an outcome: nothing was sent, nothing was asked. */
function notPaired() {
  return { isError: true as const, content: [{ type: "text" as const, text: NOT_PAIRED }] };
}

function interactionScope(tool: "ask" | "ask_yes_no", text: string): TaskInteractionScope | undefined {
  const attributed = consumeAttributedCall(tool, { question: text }, Date.now(), sessionFromEnvironment());
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

type ToolAnswer = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

async function answerYesNo(questionText: string, scope?: TaskInteractionScope): Promise<ToolAnswer> {
  const client = await relay();
  if (!client) return notPaired();
  const outcome = await askYesNoOutcome(client, questionText, undefined, scope);
  return answered(yesNoText(outcome), outcome);
}

async function answerOpenQuestion(questionText: string, scope?: TaskInteractionScope): Promise<ToolAnswer> {
  const client = await relay();
  if (!client) return notPaired();
  const outcome = await askOpenQuestionOutcome(client, questionText, undefined, scope);
  return answered(openAnswerText(outcome), outcome);
}
