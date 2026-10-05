import { computerDisplayName } from "../../../../packages/core/computer-name";
import { loadConfig } from "../../../bridge/src/config";
import { connectionRuntimeStatus } from "../mcp-tools/connect/relay";
import { packageVersion } from "./package-version";
import { computerId } from "../../../bridge/src/mesh/identity/computer";
import { loadAccountLink } from "../../../bridge/src/account-recovery/link";
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
    computer: computerDisplayName(),
    endpointId: computerId(),
    accountLinkSaved: loadAccountLink() !== null,
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
