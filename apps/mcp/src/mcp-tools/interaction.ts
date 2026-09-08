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
import { argumentsDigest, OperationLedger, type OperationRecord } from "./operation-ledger";
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
  + "the part that failed is done again. The name is yours for a quarter of an hour, for this "
  + "call's own arguments; the same name with other arguments is refused.",
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
const OPERATION_CONFLICT =
  "This operationId was already used for a different call. A name means one call's arguments; "
  + "use a new operationId for a new call.";
const STORE_BUSY =
  "The Mesh store is busy on this computer; nothing was recorded. Retry with the same operationId.";

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

type ToolAnswer = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function answered(text: string, outcome: Record<string, unknown>): ToolAnswer {
  return { content: [{ type: "text", text }], structuredContent: outcome };
}

function refused(text: string): ToolAnswer {
  return { isError: true, content: [{ type: "text", text }] };
}

function replayed(record: OperationRecord): ToolAnswer {
  return answered(`${record.text}\n(replayed: this operationId was already handled)`, { ...record.outcome, replayed: true });
}

/** A record's answer, whether it was made now or earlier. */
function fromRecord(record: OperationRecord, isReplay: boolean): ToolAnswer {
  return isReplay ? replayed(record) : answered(record.text, record.outcome);
}

export function registerInteractionTools(server: McpServer): void {
  // One ledger per server: a chat's names are that chat's, and a server that
  // hosts several chats keeps each one's apart by the execution it resolved.
  const ledger = new OperationLedger();

  /**
   * Answer a named call once. The name is looked up only after the caller is
   * known, under that caller; a name reused for other arguments is refused;
   * a retry that arrives while the first call runs waits for its answer.
   */
  async function once(
    principal: string,
    tool: string,
    operation: string | undefined,
    digest: string,
    work: (previous: OperationRecord | undefined) => Promise<OperationRecord>,
  ): Promise<ToolAnswer> {
    if (!operation) return fromRecord(await work(undefined), false);
    const recalled = ledger.recall(principal, tool, operation, digest);
    if (recalled.kind === "conflict") return refused(OPERATION_CONFLICT);
    if (recalled.kind === "in_flight") return fromRecord(await recalled.result, true);
    if (recalled.kind === "replay" && recalled.record.pending !== "message") return fromRecord(recalled.record, true);
    const previous = recalled.kind === "replay" ? recalled.record : undefined;
    const record = await ledger.run(principal, tool, operation, () => work(previous));
    return fromRecord(record, previous != null);
  }

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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ message, meshEvent, operationId: operation }) => {
      if (!message && !meshEvent) return refused("Provide message or meshEvent.");
      const client = await relay();
      if (!client) return notPaired();
      // The provider hook already saw this exact call — every argument of it,
      // the operationId included — inside its own session.
      const attributed = consumeAttributedCall(
        "notify", { message, meshEvent, operationId: operation }, Date.now(), sessionFromEnvironment(),
      );
      const principal = attributed?.sessionId ?? "unattributed";
      const digest = argumentsDigest({ message, meshEvent });
      return once(principal, "notify", operation, digest, async (previous) => {
        let outcome: Record<string, unknown>;
        let text: string;
        let changedSomething = previous != null;
        if (previous) {
          // The event went out last time; only the status text is still owed.
          outcome = { ...previous.outcome };
          text = previous.text;
        } else {
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
            return { at: Date.now(), tool: "notify", digest, text: partial, outcome, pending: "message" };
          }
        }
        return { at: Date.now(), tool: "notify", digest, text, outcome };
      });
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ question: text, operationId: operation }) => {
      const client = await relay();
      if (!client) return notPaired();
      const scope = interactionScope("ask_yes_no", text, operation);
      const digest = argumentsDigest({ question: text });
      return once(scope?.sessionId ?? "unattributed", "ask_yes_no", operation, digest, async () => {
        const outcome = await askYesNoOutcome(client, text, undefined, scope);
        return { at: Date.now(), tool: "ask_yes_no", digest, text: yesNoText(outcome), outcome };
      });
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
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ question: text, operationId: operation }) => {
      const client = await relay();
      if (!client) return notPaired();
      const scope = interactionScope("ask", text, operation);
      const digest = argumentsDigest({ question: text });
      return once(scope?.sessionId ?? "unattributed", "ask", operation, digest, async () => {
        const outcome = await askOpenQuestionOutcome(client, text, undefined, scope);
        return { at: Date.now(), tool: "ask", digest, text: openAnswerText(outcome), outcome };
      });
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
  const ttlMs = (input.expiresInSeconds ?? 3_600) * 1_000;
  if (event.eventType === "RESOURCE_CLAIM" && event.payload.claim) {
    // Checked and recorded as one step under the store's lock: the conflict
    // the claim is checked against is the state it is written into.
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
  // Keep the shared singleton warm for the MCP resource even when the monitor
  // has not yet completed its first provider scan.
  localMeshStore();
  return { status: "published", eventId: event.eventId, text: "mesh event published" };
}

/** Not paired is an error, not an outcome: nothing was sent, nothing was asked. */
function notPaired(): ToolAnswer {
  return { isError: true, content: [{ type: "text", text: NOT_PAIRED }] };
}

/**
 * The execution a question belongs to, from the provider hook's record of
 * this exact call — operationId included, because the hook saw it too.
 */
function interactionScope(tool: "ask" | "ask_yes_no", text: string, operation?: string): TaskInteractionScope | undefined {
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
