import { z } from "zod";
import { hostname } from "node:os";
import { loadConfig } from "../../../bridge/src/config";
import { isMachineConfigured, listPairedPhones, readOnlyMachineConfigPath } from "../pairing-status";
import { inspectProviderStatusSnapshot } from "../provider-status";
import { packageVersion } from "../package-version";
import { connectionRuntimeStatus } from "../mcp-tools/relay";

export const connectionOutput = {
  status: z.enum(["disconnected", "paired", "pairing", "expired", "connected"]),
  computer: z.string(),
  version: z.string(),
  relay: z.string(),
  relayStatus: z.enum(["online", "offline", "unknown"]),
  phoneLastSeenAt: z.number().nullable(),
  phones: z.array(z.object({
    name: z.string(),
    status: z.enum(["paired", "seen"]),
    lastSeenAt: z.number().nullable(),
  })),
  expiresAt: z.number().nullable(),
  expiresInMinutes: z.number().int().positive().nullable(),
  providers: z.array(z.object({ id: z.string(), status: z.string(), detail: z.string() })),
};

export type PendingCode = {
  room: string;
  expiresAt: number;
  pairingUri: string;
  qrDataUrl: string;
};

/** Ephemeral transfer material never enters logs, structured output, or disk. */
export class ConnectionState {
  private pending: PendingCode | null = null;

  remember(code: PendingCode): void {
    this.pending = code;
  }

  snapshot(now = Date.now()) {
    const config = isMachineConfigured() ? loadConfig(readOnlyMachineConfigPath()) : null;
    const runtime = connectionRuntimeStatus(config?.room);
    if (!config || this.pending?.room !== config.room || runtime.phoneLastSeenAt) this.pending = null;
    const expired = this.pending !== null && this.pending.expiresAt <= now;
    const status = !config ? "disconnected" : this.pending
      ? expired ? "expired" : "pairing"
      : runtime.phoneLastSeenAt && now - runtime.phoneLastSeenAt < 60_000 ? "connected" : "paired";
    const code = expired ? null : this.pending;
    return {
      structuredContent: {
        status,
        computer: hostname(),
        version: packageVersion(),
        relay: config ? new URL(config.relayUrl).host : "",
        relayStatus: runtime.relayStatus,
        phoneLastSeenAt: runtime.phoneLastSeenAt,
        phones: listPairedPhones(runtime.phoneLastSeenAt, now),
        expiresAt: this.pending?.expiresAt ?? null,
        expiresInMinutes: code ? Math.max(1, Math.ceil((code.expiresAt - now) / 60_000)) : null,
        providers: inspectProviderStatusSnapshot().providers,
      },
      _meta: { granttap: code ? { pairingUri: code.pairingUri, qrDataUrl: code.qrDataUrl } : {} },
    };
  }
}
