import type { AccountMachineLink } from "../../../../packages/protocol/schema";
import { loadAccountLink, saveAccountLink } from "./link";

/** A trusted QR room can enroll an unlinked Mac, never replace its machine identity. */
export async function acceptPhoneAccountLink(
  link: AccountMachineLink, origin: string, request: typeof fetch = fetch,
): Promise<boolean> {
  if (new URL(origin).protocol !== "https:") return false;
  const current = loadAccountLink();
  if (current && (current.accountId !== link.accountId
    || current.machineId !== link.machineId)) return false;
  const response = await request(`${origin}/api/account/machine/identity`, {
    headers: { authorization: `Bearer ${link.machineToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(8_000), redirect: "error",
  });
  if (!response.ok) return false;
  const identity = await response.json() as { accountId?: string; machineId?: string };
  if (identity.accountId !== link.accountId || identity.machineId !== link.machineId) return false;
  return saveAccountLink({ accountId: link.accountId,
    machineId: link.machineId, machineToken: link.machineToken });
}
