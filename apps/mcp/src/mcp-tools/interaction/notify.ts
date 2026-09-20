import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executionCapabilityFor } from "../../../../bridge/src/mesh/catalog/capability";
import { consumeAttributedCall } from "../../../../bridge/src/mesh/identity/call-scope";
import { isMeshEnabled } from "../../../../bridge/src/config/runtime";
import { sessionFromEnvironment } from "../mesh/resource";
import { argumentsDigest, type OperationRecord } from "../operation-ledger";
import { notPaired, refused, type ToolAnswer } from "./answers";
import { relay } from "../connect/relay";
import { meshEventInput, publishMeshEvent } from "./publish";

const operationId = z.string().trim().min(1).max(128).optional().describe(
  "A name of your own for this call. Retrying with the same operationId repeats nothing that "
  + "already happened: an event is not published twice, a person is not asked twice, and only "
  + "the part that failed is done again. The name is yours for a quarter of an hour, for this "
  + "call's own arguments; the same name with other arguments is refused.",
);

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

export type Once = (
  principal: string,
  tool: string,
  operation: string | undefined,
  digest: string,
  work: (previous: OperationRecord | undefined) => Promise<OperationRecord>,
) => Promise<ToolAnswer>;

export function registerNotifyTool(server: McpServer, once: Once): void {
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
      const attributed = consumeAttributedCall(
        "notify", { message, meshEvent, operationId: operation }, Date.now(), sessionFromEnvironment(),
      );
      const principal = attributed?.sessionId ?? "unattributed";
      const digest = argumentsDigest({ message, meshEvent });
      return once(principal, "notify", operation, digest, async (previous) => {
        return completeNotify({ client, message, meshEvent, attributedSessionId: attributed?.sessionId, digest, previous });
      });
    },
  );
}

async function completeNotify(input: {
  client: NonNullable<Awaited<ReturnType<typeof relay>>>;
  message?: string;
  meshEvent?: z.infer<typeof meshEventInput>;
  attributedSessionId?: string;
  digest: string;
  previous: OperationRecord | undefined;
}): Promise<OperationRecord> {
  const { client, message, meshEvent, attributedSessionId, digest, previous } = input;
  let outcome: Record<string, unknown>;
  let text: string;
  let changedSomething = previous != null;
  if (previous) {
    outcome = { ...previous.outcome };
    text = previous.text;
  } else {
    const published = meshEvent
      ? await publishMeshEvent(client, meshEvent, attributedSessionId)
      : undefined;
    changedSomething = published != null;
    const capability = isMeshEnabled() && attributedSessionId
      ? executionCapabilityFor(attributedSessionId)
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
}
