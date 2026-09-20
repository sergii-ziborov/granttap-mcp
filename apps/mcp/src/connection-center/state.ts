import { z } from "zod";
import { hostname } from "node:os";
import { loadConfig } from "../../../bridge/src/config";
import { isMachineConfigured, listPairedPhones, readOnlyMachineConfigPath } from "../status/pairing-status";
import { inspectProviderStatusSnapshot } from "../status/provider-status";
import { packageVersion } from "../status/package-version";
import { connectionRuntimeStatus } from "../mcp-tools/connect/relay";
import { beginEnrollment, cancelEnrollment, enrollmentIsOpen } from "./enrollment";

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
  roomPrefix: z.string(),
};

export type PendingCode = {
  attemptId: string;
  room: string;
  expiresAt: number;
  pairingUri: string;
  qrDataUrl: string;
};

/** Ephemeral transfer material never enters logs, structured output, or disk. */
export class ConnectionState {
  private pending: PendingCode | null = null;

  remember(code: Omit<PendingCode, "attemptId"> & { attemptId?: string }): void {
    const attempt = beginEnrollment({
      room: code.room,
      peerPublicKey: isMachineConfigured()
        ? loadConfig(readOnlyMachineConfigPath()).peerPublicKey
        : null,
    });
    this.pending = { ...code, attemptId: code.attemptId ?? attempt.attemptId };
  }

  snapshot(now = Date.now()) {
    const config = isMachineConfigured() ? loadConfig(readOnlyMachineConfigPath()) : null;
    const runtime = connectionRuntimeStatus(config?.room);
    const phones = listPairedPhones(runtime.phoneLastSeenAt, now);
    const lastSeenAt = phones[0]?.lastSeenAt ?? runtime.phoneLastSeenAt;
    if (!config || this.pending?.room !== config.room) {
      cancelEnrollment();
      this.pending = null;
    } else if (this.pending && !enrollmentIsOpen(this.pending.attemptId)) this.pending = null;
    const expired = this.pending !== null && this.pending.expiresAt <= now;
    const status = !config ? "disconnected" : this.pending
      ? expired ? "expired" : "pairing"
      : lastSeenAt && now - lastSeenAt < 60_000 ? "connected" : "paired";
    const code = expired ? null : this.pending;
    return {
      structuredContent: {
        status,
        computer: hostname(),
        version: packageVersion(),
        relay: config ? new URL(config.relayUrl).host : "",
        relayStatus: runtime.relayStatus,
        phoneLastSeenAt: lastSeenAt,
        phones,
        expiresAt: this.pending?.expiresAt ?? null,
        expiresInMinutes: code ? Math.max(1, Math.ceil((code.expiresAt - now) / 60_000)) : null,
        providers: inspectProviderStatusSnapshot().providers,
        roomPrefix: config?.room ? config.room.slice(0, 8) : "",
      },
      _meta: { granttap: code ? { pairingUri: code.pairingUri, qrDataUrl: code.qrDataUrl } : {} },
    };
  }
}
