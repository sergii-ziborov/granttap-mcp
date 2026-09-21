import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { mcpServersForSession } from "../../../capabilities";
import { loadRuntimeConfig } from "../../../config/runtime";

/** Attach the native configuration before deriving a Project's MCP inventory. */
export function projectSessionCapabilityInventory(session: SessionInfo): SessionInfo {
  const disabled = loadRuntimeConfig().sessionMcpDisabled[session.sessionId] ?? [];
  return { ...session, mcpServers: mcpServersForSession(session, disabled) };
}
