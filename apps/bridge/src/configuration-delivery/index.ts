import type { ConfigSet } from "../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../packages/core/relay-client";
import { autoAcceptLevelFor } from "../config";
import { handleConfigSet } from "../monitor/handlers/session-commands";

/** A receipt reports effective computer policy, independently of a slow catalog scan. */
export async function handleConfigurationCommand(client: RelayClient, message: ConfigSet): Promise<void> {
  const result = handleConfigSet(message);
  if (!message.operationId) return;
  await client.send({ type: "config.command.result", operationId: message.operationId,
    ok: result.kind !== "rejected",
    ...(result.kind === "rejected" ? { reason: result.reason } : { revision: result.revision }),
    sessionId: message.autoAcceptSession?.sessionId,
    level: message.autoAcceptSession?.sessionId
      ? autoAcceptLevelFor(message.autoAcceptSession.sessionId) : undefined,
    createdAt: Date.now() }, "phone", { ttlMs: 60_000 });
}
