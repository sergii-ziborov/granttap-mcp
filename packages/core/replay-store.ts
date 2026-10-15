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

/** Replay identity belongs to authenticated ciphertext, never relay-controlled IDs. */
export class RelayMessageAcceptance {
  private readonly seen: Set<string>;
  private readonly processing = new Set<string>();

  constructor(private readonly path?: string) {
    this.seen = new Set(loadReplayFingerprints(path));
  }

  hasAccepted(fingerprint: string): boolean { return this.seen.has(fingerprint); }

  begin(fingerprint: string): boolean {
    if (this.processing.has(fingerprint)) return false;
    this.processing.add(fingerprint);
    return true;
  }

  accept(fingerprint: string): void {
    this.seen.add(fingerprint);
    if (this.seen.size > MAX_FINGERPRINTS) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    saveReplayFingerprints(this.path, this.seen);
  }

  finish(fingerprint: string): void { this.processing.delete(fingerprint); }
}
