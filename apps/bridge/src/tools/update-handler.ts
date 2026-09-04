import type { ToolUpdate, ToolUpdateResult } from "../../../../packages/protocol/schema";
import { updateTool } from "./updater";

/** Answer one `tool.update` from the phone with what the updater did. */
export async function handleToolUpdate(
  send: (result: ToolUpdateResult) => Promise<void>,
  message: ToolUpdate,
  run: (agent: ToolUpdate["agent"]) => ReturnType<typeof updateTool> = (agent) => updateTool(agent),
): Promise<void> {
  const outcome = await run(message.agent);
  await send({
    type: "tool.update.result",
    agent: message.agent,
    requestId: message.requestId,
    ok: outcome.ok,
    before: outcome.before,
    after: outcome.after,
    command: outcome.command,
    message: outcome.message,
    output: outcome.output,
    createdAt: Date.now(),
  });
}
