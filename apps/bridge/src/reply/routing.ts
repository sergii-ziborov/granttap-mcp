import type { SessionInfo } from "../../../../packages/protocol/schema";
import type { DeliveryOptions } from "./types";

export function routingPrompt(
  session: SessionInfo,
  text: string,
  options: DeliveryOptions,
): string {
  const instructions: string[] = [];
  if (options.preferredMcp) {
    instructions.push(`Use the MCP server "${options.preferredMcp}" for this request when relevant.`);
  }
  if (options.skill) {
    const invocation = session.agent === "claude" ? `/${options.skill}` : `$${options.skill}`;
    instructions.push(`Use the project skill ${invocation} for this request.`);
  }
  return instructions.length === 0 ? text : `${instructions.join("\n")}\n\n${text}`;
}
