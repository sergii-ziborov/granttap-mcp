import type { AccountMetadata, LoginMode, PendingAuthorization, PublicAuthorization } from "./contracts";

type Json = Record<string, unknown>;
function record(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Json;
}
function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || Buffer.byteLength(value) > max) {
    throw new Error(`bounded ${label} required`);
  }
  return value;
}
function time(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`safe ${label} required`);
  return value as number;
}
export function validControlBase(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("GrantTap Control must be HTTPS (HTTP only on loopback)");
  }
  return url.origin;
}
function controlUrl(value: unknown, label: string, origin: string): string {
  const url = new URL(text(value, label, 8, 2_048));
  if (url.origin !== origin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && url.origin === origin))) {
    throw new Error(`${label} must use the trusted GrantTap Control origin`);
  }
  return url.toString();
}

export function authorization(
  value: unknown, base: string, mode: LoginMode, organization: string | undefined, now: number,
): { public: PublicAuthorization; pending: PendingAuthorization } {
  const raw = record(value, "device authorization");
  const origin = validControlBase(base);
  const deviceCode = text(raw.deviceCode, "device code", 32, 1_024);
  const userCode = text(raw.userCode, "user code", 6, 32);
  if (!/^[A-Z0-9-]+$/.test(userCode)) throw new Error("canonical user code required");
  const verificationUri = controlUrl(raw.verificationUri, "verification URI", origin);
  const verificationUriComplete = controlUrl(raw.verificationUriComplete, "complete verification URI", origin);
  const verification = new URL(verificationUri);
  const complete = new URL(verificationUriComplete);
  const query = [...complete.searchParams.entries()];
  if (verification.search || verification.hash || complete.hash
      || query.length !== 1 || query[0]?.[0] !== "user_code" || query[0]?.[1] !== userCode
      || verificationUriComplete.includes(deviceCode)) {
    throw new Error("the QR may contain only its matching one-time user code");
  }
  const expiresInSec = time(raw.expiresInSec, "authorization lifetime");
  const intervalSec = time(raw.intervalSec, "poll interval");
  if (expiresInSec > 900 || intervalSec < 2 || intervalSec > 30) throw new Error("bounded device flow timing required");
  const safe = { userCode, verificationUri, verificationUriComplete,
    expiresAt: now + expiresInSec * 1_000, intervalSec, mode,
    ...(organization ? { organization } : {}) };
  return { public: safe, pending: {
    version: 1, controlBase: origin, deviceCode, codeVerifier: "", ...safe,
  } };
}

export function accountResult(
  value: unknown, expected: { mode: LoginMode; publicKey: string; controlBase: string },
): { metadata: AccountMetadata; accessToken: string; refreshToken?: string; loginReceipt?: string } {
  const raw = record(value, "authorization result");
  if (raw.status !== "authorized") throw new Error("authorized GrantTap account result required");
  const account = record(raw.account, "account");
  const mode = account.mode === "personal" || account.mode === "enterprise" ? account.mode : null;
  if (!mode || mode !== expected.mode) throw new Error("GrantTap account mode changed during login");
  const devicePublicKey = text(account.devicePublicKey, "device public key", 43, 43);
  if (devicePublicKey !== expected.publicKey) throw new Error("GrantTap login was issued to another device key");
  const metadata: AccountMetadata = {
    version: 1, mode, accountId: text(account.accountId, "account id", 16, 128),
    userId: text(account.userId, "user id", 1, 255), deviceId: text(account.deviceId, "device id", 1, 255),
    devicePublicKey, controlBase: validControlBase(expected.controlBase), expiresAt: time(account.expiresAt, "account expiry"),
    ...(account.organizationId == null ? {} : { organizationId: text(account.organizationId, "organization id", 1, 255) }),
  };
  const accessToken = text(raw.accessToken, "access token", 32, 8_192);
  const refreshToken = raw.refreshToken == null ? undefined : text(raw.refreshToken, "refresh token", 32, 8_192);
  const loginReceipt = raw.loginReceipt == null ? undefined : text(raw.loginReceipt, "login receipt", 64, 16_384);
  if (mode === "enterprise" && (!metadata.organizationId || !loginReceipt)) {
    throw new Error("enterprise authorization requires organization identity and signed login receipt");
  }
  return { metadata, accessToken, ...(refreshToken ? { refreshToken } : {}), ...(loginReceipt ? { loginReceipt } : {}) };
}
