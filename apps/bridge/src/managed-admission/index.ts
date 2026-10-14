import type { PeerConfig, RelayClientOptions } from "../../../../packages/core/relay-client";
import { loadAccountLink } from "../account-recovery/link";

/** Account computer identity is stable across QR rooms and provider sessions. */
export function managedAdmissionOptions(config: PeerConfig,
  request: typeof fetch = fetch): Pick<RelayClientOptions, "upgradeHeaders" | "connectionLeaseExpiresAt"> {
  const url = new URL(config.relayUrl);
  if (config.role !== "machine" || url.protocol !== "wss:" || url.hostname !== "relay.granttap.com") return {};
  let expiresAt: number | null = null;
  return { connectionLeaseExpiresAt: () => expiresAt,
    upgradeHeaders: async (): Promise<Record<string, string>> => {
    const account = loadAccountLink();
    if (!account) return {};
    const response = await request("https://granttap.com/api/account/machine/admission", {
      method: "POST", headers: { authorization: `Bearer ${account.machineToken}`,
        "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ publicKey: config.myPublicKey, room: config.room }),
      signal: AbortSignal.timeout(8_000), redirect: "error",
    });
    // Legacy free-beta deployments predate admission. A commercial relay still
    // independently refuses every machine socket without a valid ticket.
    if (response.status === 404 || response.status === 503) return {};
    if (!response.ok) throw new Error("Managed relay access or the computer limit must be renewed in GrantTap.");
    const body = await response.json() as { ticket?: unknown; expiresAt?: unknown };
    if (typeof body.ticket !== "string" || body.ticket.length > 2_048
      || typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt)
      || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + 360_000) {
      throw new Error("Managed admission returned an invalid lease.");
    }
    expiresAt = body.expiresAt;
    return { "X-GrantTap-Admission": body.ticket };
  } };
}
