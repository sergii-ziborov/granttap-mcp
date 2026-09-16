/**
 * Public consent snapshot for granttap.com. No pairing keys, tokens, or codes.
 */
import { inspectAgentIntegrations } from "../../../bridge/src/install";
import { loadConfig } from "../../../bridge/src/config";
import { connectionRuntimeStatus } from "../mcp-tools/relay";
import { isMachineConfigured, listPairedPhones, readOnlyMachineConfigPath } from "../pairing-status";

export type ConnectProvider = {
  id: "codex" | "claude" | "cursor";
  installed: boolean;
  ready: boolean;
};

export type ConnectSnapshot = {
  clientName: string;
  paired: boolean;
  phones: ReturnType<typeof listPairedPhones>;
  providers: ConnectProvider[];
};

export function publicClientName(name: string | undefined): string {
  return name?.trim().slice(0, 80) || "Coding app";
}

export function buildConnectSnapshot(clientName?: string): ConnectSnapshot {
  const paired = isMachineConfigured();
  return {
    clientName: publicClientName(clientName),
    paired,
    phones: listPairedPhones(connectionRuntimeStatus(
      paired ? loadConfig(readOnlyMachineConfigPath()).room : undefined,
    ).phoneLastSeenAt),
    providers: inspectAgentIntegrations()
      .filter((item): item is typeof item & { agent: ConnectProvider["id"] } =>
        item.agent === "codex" || item.agent === "claude" || item.agent === "cursor")
      .map((item) => ({
        id: item.agent,
        installed: item.installed,
        ready: item.hookConfigured,
      })),
  };
}
