import { randomBytes, randomUUID } from "node:crypto";
import { verifyAccountLink } from "../../../bridge/src/account-link-state";
import { buildConnectSnapshot } from "../oauth/session/connect-snapshot";
import { publishConnectRequestRetry, watchConnectDecision, websiteOrigin } from "../oauth/consent/website-session";

const REQUEST_LIFETIME_MS = 15 * 60_000;
let pending: { url: string; expiresAt: number } | null = null;
const signedIn = new Set<() => void>();

/** Told each time a passkey sign-in started in this process saved this computer's account link and the page moved on. */
export function onAccountSignedIn(listener: () => void): () => void {
  signedIn.add(listener);
  return () => { signedIn.delete(listener); };
}

/** The saved sign-in is checked at once, so status shows it confirmed instead of waiting for the next poll. */
async function afterSignIn(origin: string): Promise<void> {
  await verifyAccountLink(origin).catch(() => undefined);
  for (const listener of signedIn) { try { listener(); } catch { /* one listener never stops another */ } }
}

/**
 * Start a browser passkey ceremony that signs this computer in to a GrantTap account (`sign_in`, the card's
 * Sign in again, `granttap sign-in`). No account credential enters MCP output: the site hands the machine
 * token only to this process's watcher, which saves it privately.
 */
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
    if (!approved || method !== "passkey") throw new Error("Use the account passkey to sign this computer in.");
    pending = null;
    return { redirectUrl: `${origin}/account` };
  }, { requestSecret: secret, onRedirected: () => { void afterSignIn(origin); } });
  const url = `${origin}/connect#request=${id}`;
  pending = { url, expiresAt: Date.now() + REQUEST_LIFETIME_MS };
  return url;
}

/** For tests: forget a sign-in page this process started. */
export function resetPasskeyAccountLink(): void { pending = null; }
