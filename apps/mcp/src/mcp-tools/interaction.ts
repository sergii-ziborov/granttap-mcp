import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { askOpenQuestion, askYesNo, relay } from "./relay";

const NOT_PAIRED = "GrantTap is not paired on this machine. Pair the desktop bridge with the GrantTap app first.";
const question = z.string().min(1).max(8_000).describe("The question to ask");

export function registerInteractionTools(server: McpServer): void {
  server.tool(
    "notify",
    "Push a short status/message to the user's phone. Fire-and-forget — use it to keep them informed without blocking.",
    { message: z.string().min(1).max(8_000).describe("Text to show on the phone") },
    async ({ message }) => {
      const client = await relay();
      if (!client) return notPaired();
      await client.send({ type: "agent.event", text: message, kind: "status", createdAt: Date.now() }, "phone", { ttlMs: 15 * 60_000, wake: true });
      return { content: [{ type: "text", text: "sent to phone" }] };
    },
  );
  server.tool("ask_yes_no", "Ask the user a yes/no question on their phone/watch and wait for the tap. Returns 'yes' or 'no'.", { question: question.describe("A question answerable with yes/no") }, async ({ question: text }) => answerYesNo(text));
  server.tool("ask", "Ask the user an open question on their phone/watch and wait for their spoken or typed reply. Returns their answer text.", { question }, async ({ question: text }) => answerOpenQuestion(text));
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
