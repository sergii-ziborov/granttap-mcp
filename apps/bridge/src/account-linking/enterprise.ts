import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { atomicPrivate } from "./store";

type Manifest = {
  tenantId: string; subjectId: string; subjectKeyId: Buffer;
  loginIssuerId: string; loginIssuerKeyId: Buffer; loginIssuerPublicKey: Buffer;
  minimumAuthorizationEpoch: bigint;
};

function bytes32(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error(`invalid ${label}`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) throw new Error(`invalid ${label}`);
  return bytes;
}
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 255) throw new Error(`invalid ${label}`);
  return value;
}
function same(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
function keyId(key: Buffer): Buffer {
  const domain = Buffer.from("granttap/control/login-issuer-key-id/v1");
  const length = Buffer.alloc(4); length.writeUInt32BE(domain.length);
  return createHash("sha256").update(length).update(domain).update(key).digest();
}
function manifest(root: string): Manifest {
  const path = join(root, "managed", "issuer.json");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > 16_384) throw new Error("safe managed issuer manifest required");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw.version !== 2) throw new Error("secure-login issuer manifest v2 required");
  const result = {
    tenantId: id(raw.tenantId, "tenant"), subjectId: id(raw.subjectId, "subject"),
    subjectKeyId: bytes32(raw.subjectKeyId, "subject key"),
    loginIssuerId: id(raw.loginIssuerId, "login issuer"),
    loginIssuerKeyId: bytes32(raw.loginIssuerKeyId, "login issuer key id"),
    loginIssuerPublicKey: bytes32(raw.loginIssuerPublicKey, "login issuer public key"),
    minimumAuthorizationEpoch: BigInt(id(raw.minimumAuthorizationEpoch, "authorization epoch")),
  };
  if (!same(result.loginIssuerKeyId, keyId(result.loginIssuerPublicKey))) {
    throw new Error("login issuer key id does not match its public key");
  }
  return result;
}
function segment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid login receipt encoding");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("non-canonical login receipt encoding");
  return decoded;
}

export function installLoginReceipt(root: string, compact: string, expectedSubject: Buffer, nowMs: number): void {
  const issuer = manifest(root);
  if (!same(issuer.subjectKeyId, expectedSubject)) throw new Error("enterprise enrollment is pinned to another device key");
  const parts = compact.split(".");
  if (parts.length !== 3) throw new Error("compact login receipt required");
  const [headerText, payloadText, signatureText] = parts as [string, string, string];
  const header = JSON.parse(segment(headerText).toString("utf8")) as Record<string, unknown>;
  if (header.alg !== "EdDSA" || header.typ !== "GTLOGIN"
      || header.kid !== issuer.loginIssuerKeyId.toString("base64url")) throw new Error("untrusted login receipt header");
  const signature = segment(signatureText);
  if (signature.length !== 64 || !nacl.sign.detached.verify(
    Buffer.from(`${headerText}.${payloadText}`), signature, issuer.loginIssuerPublicKey,
  )) throw new Error("invalid login receipt signature");
  const payload = JSON.parse(segment(payloadText).toString("utf8")) as Record<string, unknown>;
  const subject = bytes32(payload.subjectKeyId, "receipt subject key");
  const epoch = BigInt(id(payload.authorizationEpoch, "receipt authorization epoch"));
  const now = Math.floor(nowMs / 1_000);
  if (payload.version !== 1 || payload.tenantId !== issuer.tenantId || payload.subjectId !== issuer.subjectId
      || payload.issuerId !== issuer.loginIssuerId || !same(subject, issuer.subjectKeyId)) {
    throw new Error("login receipt targets another endpoint");
  }
  if (!Number.isSafeInteger(payload.authenticatedAt) || !Number.isSafeInteger(payload.expiresAt)
      || (payload.authenticatedAt as number) > now || (payload.expiresAt as number) <= now) {
    throw new Error("enterprise login is expired");
  }
  if (epoch < issuer.minimumAuthorizationEpoch) throw new Error("enterprise login is revoked");
  atomicPrivate(join(root, "managed", "login.receipt"), compact);
}
