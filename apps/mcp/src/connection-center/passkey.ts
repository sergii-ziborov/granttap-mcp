import { randomBytes, randomUUID } from "node:crypto";
import { buildConnectSnapshot } from "../oauth/session/connect-snapshot";
import { publishConnectRequestRetry, watchConnectDecision, websiteOrigin } from "../oauth/consent/website-session";

const REQUEST_LIFETIME_MS = 15 * 60_000;
let pending: { url: string; expiresAt: number } | null = null;

/** Start a browser passkey ceremony for this Mac. No account credential enters MCP output. */
export async function startPasskeyAccountLink(): Promise<string> {
  if (pending && pending.expiresAt > Date.now()) return pending.url;
  const origin = websiteOrigin();
  if (!origin) throw new Error("GrantTap account service is unavailable.");
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const snapshot = () => ({ ...buildConnectSnapshot("GrantTap MCP"), purpose: "account-link" as const });
  if (!await publishConnectRequestRetry(origin, id, snapshot(), 3, secret)) {
    throw new Error("GrantTap account service did not accept the connection request.");
  }
  watchConnectDecision(origin, id, snapshot, (approved, method) => {
    if (!approved || method !== "passkey") throw new Error("Use the account passkey to link this Mac.");
    pending = null;
    return { redirectUrl: `${origin}/account` };
  }, { requestSecret: secret });
  const url = `${origin}/connect#request=${id}`;
  pending = { url, expiresAt: Date.now() + REQUEST_LIFETIME_MS };
  return url;
}
