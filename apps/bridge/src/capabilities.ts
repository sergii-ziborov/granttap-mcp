import type { McpServerInfo, SessionInfo } from "../../../packages/protocol/schema";
import { descriptorsForSession } from "./capabilities/descriptors";
import { cachedMetadata, refreshDescriptorMetadata } from "./capabilities/metadata";

export { workspaceSkills } from "./capabilities/skills";

/** Resolve real MCP initialization metadata and cache it for a session. */
export async function refreshMcpMetadataForSession(session: SessionInfo): Promise<void> {
  await Promise.all(descriptorsForSession(session).map(refreshDescriptorMetadata));
}

export function mcpServersForSession(session: SessionInfo, disabled: string[]): McpServerInfo[] {
  const descriptors = descriptorsForSession(session);
  void Promise.all(descriptors.map(refreshDescriptorMetadata));
  const denied = new Set(disabled);
  return descriptors.map((descriptor) => {
    const configuredEnabled = descriptor.configuredEnabled;
    const base: McpServerInfo = {
      name: descriptor.name,
      configuredEnabled,
      allowed: configuredEnabled && !denied.has(descriptor.name),
      ...(descriptor.authStatus ? { authStatus: descriptor.authStatus } : {}),
    };
    const metadata = cachedMetadata(descriptor);
    return metadata ? { ...base, ...metadata } : base;
  });
}
