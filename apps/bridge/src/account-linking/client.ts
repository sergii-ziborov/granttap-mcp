import { randomBytes } from "node:crypto";
import type { LoginMode, PublicAuthorization } from "./contracts";
import { challenge, deviceIdentity, proof, subjectKeyId } from "./device";
import { installLoginReceipt } from "./enterprise";
import { AccountStore } from "./store";
import { accountResult, authorization, validControlBase } from "./validation";

async function json(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body) > 64_000) throw new Error("GrantTap Control response is too large");
  try { return JSON.parse(body); } catch { throw new Error("GrantTap Control returned invalid JSON"); }
}

export async function startLogin(store: AccountStore, options: {
  controlUrl: string; mode: LoginMode; organization?: string; fetchImpl?: typeof fetch; now?: number;
}): Promise<PublicAuthorization> {
  const now = options.now ?? Date.now();
  const base = validControlBase(options.controlUrl);
  const identity = deviceIdentity(store.vault);
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = challenge(verifier);
  const fields = { challenge: codeChallenge, deviceId: identity.deviceId,
    devicePublicKey: identity.publicKey, issuedAt: Math.floor(now / 1_000),
    mode: options.mode, organization: options.organization ?? "" };
  const response = await (options.fetchImpl ?? fetch)(`${base}/v1/device-authorizations`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ version: 1, ...fields, codeChallengeMethod: "S256",
      proof: proof(fields, identity.secretKey) }),
  });
  if (!response.ok) throw new Error(`GrantTap Control rejected login start (HTTP ${response.status})`);
  const parsed = authorization(await json(response), base, options.mode, options.organization, now);
  parsed.pending.codeVerifier = verifier; store.savePending(parsed.pending);
  return parsed.public;
}

export async function completeLogin(
  store: AccountStore, fetchImpl: typeof fetch = fetch, now = Date.now(),
): Promise<"pending" | "authorized"> {
  const pending = store.pending();
  if (!pending || pending.expiresAt <= now) throw new Error("No live GrantTap login is waiting for a scan");
  const identity = deviceIdentity(store.vault);
  const fields = { deviceCodeHash: challenge(pending.deviceCode),
    deviceId: identity.deviceId, issuedAt: Math.floor(now / 1_000) };
  const response = await fetchImpl(`${pending.controlBase}/v1/device-authorizations/token`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ version: 1, deviceCode: pending.deviceCode,
      codeVerifier: pending.codeVerifier, ...fields, proof: proof(fields, identity.secretKey) }),
  });
  if ([202, 428, 429].includes(response.status)) return "pending";
  if (!response.ok) throw new Error(`GrantTap Control rejected login completion (HTTP ${response.status})`);
  const account = accountResult(await json(response), {
    mode: pending.mode, publicKey: identity.publicKey, controlBase: pending.controlBase,
  });
  if (pending.mode === "enterprise") {
    installLoginReceipt(store.root, account.loginReceipt!, subjectKeyId(identity.publicKey), now);
  }
  store.saveSession(account.metadata, account.accessToken, account.refreshToken);
  return "authorized";
}
