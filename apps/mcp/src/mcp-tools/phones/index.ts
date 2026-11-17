import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computerDisplayName } from "../../../../../packages/core/computer-name";
import { randomId } from "../../../../../packages/core/crypto";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { askYesNoOutcome, relay, type TaskInteractionScope } from "../connect/relay";
import { notPaired } from "../interaction/answers";
import { attributedScope } from "../interaction/publish";
import { removePhonesWithConsent, type Consent } from "./removal";

const phone = z.object({
  id: z.string(), label: z.string(), name: z.string(),
  lastSeenAt: z.number().nullable().describe("null: this computer never heard from it"),
});

/** The yes/no question every GrantTap phone already answers, plus which phone key answered it. */
function askOnPhone(client: RelayClient, scope: TaskInteractionScope | undefined) {
  return async (question: string): Promise<Consent> => {
    const requestId = randomId(6);
    let answeredBy: string | undefined;
    const off = client.onMessage((payload, peerPublicKey) => {
      if (payload.type === "approval.decision" && payload.requestId === requestId) answeredBy = peerPublicKey;
      return false;
    });
    try {
      return { outcome: await askYesNoOutcome(client, question, undefined, scope, requestId), answeredBy };
    } finally { off(); }
  };
}

export function registerPhonesTool(server: McpServer): void {
  server.registerTool("remove_phones", {
    title: "Remove phones paired with this computer",
    description: "Ask the person to remove phones or iPads paired with this computer that are no longer used: test "
      + "installs, deleted apps, old devices. connection_status lists them with ids and when each last reached this "
      + "computer. Choose with notSeenForDays (not heard from, and not added, for that many days, never the phone heard "
      + "from most recently; connection_status marks the 30-day ones stale), phoneIds (ids or their six-character "
      + "labels), or both. Nothing is removed until the person answers yes on a phone, within "
      + "about three minutes; no answer removes nothing. The phone that answers, any phone that reaches this computer "
      + "while the question is open, and the last phone always stay. A removed phone stops receiving from this "
      + "computer at once and needs a new QR to pair again.",
    inputSchema: {
      notSeenForDays: z.number().int().min(1).max(3_650).optional()
        .describe("Remove phones not heard from, and not added, for at least this many days; 30 is a good default"),
      phoneIds: z.array(z.string().trim().regex(/^[a-fA-F0-9]{6,64}$/)).min(1).max(32).optional()
        .describe("Ids or labels from connection_status; with notSeenForDays, only those also idle that long"),
    },
    outputSchema: {
      status: z.enum(["removed", "declined", "timed_out", "nothing_to_remove"])
        .describe("declined: the person said no; timed_out: nobody answered, which is not a yes"),
      removed: z.array(phone),
      kept: z.array(phone.extend({ reason: z.string() })).describe("Chosen phones that stayed, and why"),
      remaining: z.number().int().nonnegative().describe("Phones still paired with this computer"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    // The connection card's Remove buttons call it too; the yes on a phone is still required.
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  }, async ({ notSeenForDays, phoneIds }) => {
    const client = await relay();
    if (!client) return notPaired();
    const scope = attributedScope("remove_phones", { notSeenForDays, phoneIds });
    return removePhonesWithConsent({ notSeenForDays, phoneIds }, {
      room: client.room, computer: computerDisplayName(), ask: askOnPhone(client, scope),
    });
  });
}
