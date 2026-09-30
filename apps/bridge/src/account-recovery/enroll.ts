import { hostname } from "node:os";
import { loadAccountLink, saveAccountLink } from "./link";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Native Mac app authorizes this MCP with its account session over protected loopback. */
export async function enrollMacAccount(accountToken: string, origin: string,
  request: typeof fetch = fetch): Promise<{ accountId: string; machineId: string }> {
  if (!TOKEN.test(accountToken) || new URL(origin).protocol !== "https:") {
    throw new Error("Invalid account authorization.");
  }
  const headers = { authorization: `Bearer ${accountToken}`, accept: "application/json" };
  const response = await request(`${origin}/api/account/me`, {
    headers, signal: AbortSignal.timeout(8_000), redirect: "error",
  });
  if (!response.ok) throw new Error("Account passkey session was not accepted.");
  const me = await response.json() as { accountId?: string };
  if (!me.accountId || !UUID.test(me.accountId)) throw new Error("Invalid account identity.");
  const existing = loadAccountLink();
  if (existing) {
    if (existing.accountId !== me.accountId) {
      throw new Error("This Mac is linked to a different account. Revoke it first.");
    }
    return { accountId: existing.accountId, machineId: existing.machineId };
  }
  const registration = await request(`${origin}/api/account/machines`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: hostname().slice(0, 80) }),
    signal: AbortSignal.timeout(8_000), redirect: "error",
  });
  if (registration.status !== 201 && registration.status !== 200) {
    throw new Error(`Account machine registration failed (${registration.status}).`);
  }
  const row = await registration.json() as { id?: string; machineToken?: string };
  if (!row.id || !row.machineToken || !saveAccountLink({
    accountId: me.accountId, machineId: row.id, machineToken: row.machineToken,
  })) throw new Error("Account machine authorization could not be saved.");
  return { accountId: me.accountId, machineId: row.id };
}
