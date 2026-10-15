import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { loadRuntimeConfig } from "../../config";
import type { DeliveryOptions } from "../../reply/payload/types";
import { mcpServersForSession, workspaceSkills } from "..";

/** Validate explicit routing against current machine and Task capability rules. */
export function deliveryRoutingError(target: SessionInfo, options: DeliveryOptions): string | undefined {
  const runtime = loadRuntimeConfig();
  const settings = runtime.providerSettings;
  if (target.agent in settings && settings[target.agent as keyof typeof settings] === false) {
    return "This agent is disabled in GrantTap Settings.";
  }
  if (options.preferredMcp) {
    const disabled = runtime.sessionMcpDisabled[target.sessionId] ?? [];
    if (!mcpServersForSession(target, disabled).some(server => server.name === options.preferredMcp && server.allowed)) {
      return "The selected MCP server is not allowed for this task.";
    }
  }
  if (options.skill) {
    if (!workspaceSkills(target.cwd).some(skill => skill.name === options.skill)) {
      return "The selected project skill is no longer available in this task's folder.";
    }
    if ((runtime.sessionSkillsDisabled[target.sessionId] ?? []).includes(options.skill)) {
      return "The selected project skill is disabled for this task.";
    }
  }
  return undefined;
}
