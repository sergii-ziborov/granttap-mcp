import type { McpServerInfo, SessionInfo } from "../../../../packages/protocol/schema";
import { descriptorsForProvider, descriptorsForSession, mcpConfigDigest } from "./descriptors";
import { cachedMetadata, refreshDescriptorMetadata } from "./metadata";

export { projectSharedSkills, workspaceSkills } from "./skills";
export { mcpConfigDigest } from "./descriptors";

/** Resolve real MCP initialization metadata and cache it for a session. */
export async function refreshMcpMetadataForSession(session: SessionInfo): Promise<void> {
  await Promise.all(descriptorsForSession(session).map(refreshDescriptorMetadata));
}

export function mcpServersForSession(session: SessionInfo, disabled: string[]): McpServerInfo[] {
  const descriptors = descriptorsForSession(session);
  return mcpServersFromDescriptors(descriptors, disabled);
}

export function mcpServersForProvider(
  provider: string, cwd: string | undefined,
): McpServerInfo[] {
  return mcpServersFromDescriptors(descriptorsForProvider(provider, cwd), [], false);
}

function mcpServersFromDescriptors(
  descriptors: ReturnType<typeof descriptorsForSession>, disabled: string[], probe = true,
): McpServerInfo[] {
  if (probe) void Promise.all(descriptors.map(refreshDescriptorMetadata));
  const denied = new Set(disabled);
  return descriptors.map((descriptor) => {
    const configuredEnabled = descriptor.configuredEnabled;
    const configDigest = mcpConfigDigest(descriptor.transport);
    const base: McpServerInfo = {
      name: descriptor.name,
      configuredEnabled,
      allowed: configuredEnabled && !denied.has(descriptor.name),
      ...(configDigest ? { configDigest } : {}),
      ...(descriptor.authStatus ? { authStatus: descriptor.authStatus } : {}),
    };
    const metadata = cachedMetadata(descriptor);
    return metadata ? { ...base, ...metadata } : base;
  });
}
