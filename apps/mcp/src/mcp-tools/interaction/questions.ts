import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { argumentsDigest } from "../operation-ledger";
import { notPaired } from "./answers";
import {
  askOpenQuestionOutcome,
  askYesNoOutcome,
  openAnswerText,
  relay,
  yesNoText,
} from "../connect/relay";
import { interactionScope } from "./publish";
import type { Once } from "./notify";

const question = z.string().min(1).max(8_000).describe("The question to ask");
const operationId = z.string().trim().min(1).max(128).optional().describe(
  "A name of your own for this call. Retrying with the same operationId repeats nothing that "
  + "already happened.",
);

export function registerQuestionTools(server: McpServer, once: Once): void {
  server.registerTool(
    "ask_yes_no",
    {
      description:
        "Ask the user a yes/no question on their phone/watch and wait for the tap. Returns 'yes' or 'no' "
        + "when they answered, or 'no-answer (timeout)' when nobody answered in time. A timeout is not a "
        + "refusal: do not treat it as 'no', and do not treat it as permission. With an operationId, a retry "
        + "returns the answer already given instead of asking again.",
      inputSchema: { question: question.describe("A question answerable with yes/no"), operationId },
      outputSchema: {
        status: z.enum(["answered", "timed_out"]).describe("timed_out: nobody answered before the wait ended"),
        decision: z.enum(["yes", "no"]).nullable().describe("The person's answer; null when nobody answered. A timeout is not a refusal."),
        replayed: z.boolean().optional().describe("This answer repeats an earlier call with the same operationId"),
      },
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
      outputSchema: {
        status: z.enum(["answered", "timed_out"]).describe("timed_out: nobody answered before the wait ended"),
        answer: z.string().nullable().describe("The person's words; null when nobody answered"),
        replayed: z.boolean().optional().describe("This answer repeats an earlier call with the same operationId"),
      },
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
