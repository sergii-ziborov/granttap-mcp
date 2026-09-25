import { hostname } from "node:os";
import { loadConfig } from "../../../bridge/src/config";
import { connectionRuntimeStatus } from "../mcp-tools/connect/relay";
import { packageVersion } from "./package-version";
import {
  isMachineConfigured, listPairedPhones, phoneReachability, readOnlyMachineConfigPath,
} from "./pairing-status";
import { inspectProviderStatusSnapshot } from "./provider-status";

/** Sanitized local observations for the native Mac app; no keys or pairing links. */
export function desktopStatusSnapshot(desktopEngineSocket?: string) {
  const configured = isMachineConfigured();
  const config = configured ? loadConfig(readOnlyMachineConfigPath()) : null;
  const runtime = connectionRuntimeStatus(config?.room);
  const phones = listPairedPhones(runtime.phoneLastSeenAt);
  return {
    schema: "granttap.desktop-status.v1" as const,
    ok: true,
    service: "granttap-mcp" as const,
    computer: hostname(),
    version: packageVersion(),
    paired: configured,
    phoneReachability: phoneReachability(phones),
    phones,
    relayHost: config ? new URL(config.relayUrl).host : "",
    relayStatus: runtime.relayStatus,
    providers: inspectProviderStatusSnapshot().providers,
    desktopEngineSocket,
  };
}
