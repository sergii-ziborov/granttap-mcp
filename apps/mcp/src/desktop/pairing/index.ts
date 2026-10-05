import { computerDisplayName } from "../../../../../packages/core/computer-name";
import { loadConfig } from "../../../../bridge/src/config";
import { reloadPairingHelper } from "../../../../bridge/src/install";
import { createOneTimePairing, DEFAULT_RELAY, PAIRING_CODE_TTL_MINUTES } from "../../../../bridge/src/pairing";
import { controllerPeerGate } from "../../../../bridge/src/pairing/controllers";
import { readControllerLastSeenAt } from "../../../../bridge/src/pairing/presence";
import { isMachineConfigured, readOnlyMachineConfigPath } from "../../status/pairing-status";

type Pending = { room: string; uri: string; peer: string; issuedAt: number; expiresAt: number; connected?: boolean };
export type DesktopControllerCode = {
  operation: "desktop.controller_enrollment";
  status: "idle" | "pending" | "connected" | "expired" | "unavailable";
  computer: string;
  expires_at?: number;
  uri?: string;
};

/** Private same-user channel. Transfer material lives only in this bridge process. */
export class DesktopControllerEnrollment {
  private pending: Pending | null = null;
  private creating: Promise<DesktopControllerCode> | null = null;

  constructor(private readonly onPairingChanged: () => void = () => {}) {}

  async read(input: unknown): Promise<DesktopControllerCode | undefined> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const query = input as Record<string, unknown>;
    if (Object.keys(query).some((key) => !["action", "confirmed"].includes(key))) return undefined;
    if (query.action === "status") return this.snapshot();
    if (query.action !== "create" || query.confirmed !== "true") return undefined;
    if (this.creating) return this.creating;
    const current = this.snapshot();
    if (current.status === "pending") return current;
    this.creating = this.create().finally(() => { this.creating = null; });
    return this.creating;
  }

  snapshot(now = Date.now()): DesktopControllerCode {
    const result: DesktopControllerCode = {
      operation: "desktop.controller_enrollment", status: "idle", computer: computerDisplayName(),
    };
    if (!this.pending) return result;
    if (!isMachineConfigured()) { this.pending = null; return result; }
    const machine = loadConfig(readOnlyMachineConfigPath());
    if (machine.room !== this.pending.room) { this.pending = null; return result; }
    if (this.pending.connected && controllerPeerGate(machine)(this.pending.peer)) {
      return { ...result, status: "connected" };
    }
    const at = readControllerLastSeenAt(this.pending.peer);
    if (at != null && at >= this.pending.issuedAt && at <= this.pending.expiresAt
      && controllerPeerGate(machine)(this.pending.peer)) {
      this.pending.connected = true;
      this.pending.uri = "";
      return { ...result, status: "connected" };
    }
    if (this.pending.expiresAt <= now) {
      return { ...result, status: "expired", expires_at: this.pending.expiresAt };
    }
    return { ...result, status: "pending", expires_at: this.pending.expiresAt, uri: this.pending.uri };
  }

  close(): void { this.pending = null; }

  private async create(): Promise<DesktopControllerCode> {
    try {
      const paired = isMachineConfigured();
      const relay = paired ? loadConfig(readOnlyMachineConfigPath()).relayUrl
        : process.env.GRANTTAP_TEST_RELAY_URL ?? DEFAULT_RELAY;
      const issuedAt = Date.now();
      const pairing = await createOneTimePairing(relay, {
        addController: paired, installHooks: false,
      });
      this.pending = { room: pairing.machineCfg.room, uri: pairing.qrPayload,
        peer: pairing.phoneCfg.myPublicKey, issuedAt,
        expiresAt: issuedAt + PAIRING_CODE_TTL_MINUTES * 60_000 };
      reloadPairingHelper({ firstPairing: !paired });
      this.onPairingChanged();
      return this.snapshot();
    } catch {
      return { operation: "desktop.controller_enrollment", status: "unavailable",
        computer: computerDisplayName() };
    }
  }
}
