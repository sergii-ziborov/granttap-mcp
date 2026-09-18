import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_FINGERPRINTS = 2_048;

export function ciphertextFingerprint(nonce: string, box: string): string {
  return createHash("sha256").update(nonce).update(".").update(box).digest("base64url");
}

export function loadReplayFingerprints(path: string | undefined): string[] {
  if (!path) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { fingerprints?: unknown };
    if (!Array.isArray(raw.fingerprints)) return [];
    return raw.fingerprints.filter((item): item is string => typeof item === "string").slice(-MAX_FINGERPRINTS);
  } catch {
    return [];
  }
}

export function saveReplayFingerprints(path: string | undefined, fingerprints: Iterable<string>): void {
  if (!path) return;
  const values = [...fingerprints].slice(-MAX_FINGERPRINTS);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ fingerprints: values })}\n`, { mode: 0o600 });
    if (process.platform === "win32" && existsSync(path)) unlinkSync(path);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
