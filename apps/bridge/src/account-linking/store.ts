import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AccountMetadata, AccountStatus, PendingAuthorization, SecretVault } from "./contracts";

const PENDING = "pending-device-login-v1";
const SESSION = "account-session-v1";

export function atomicPrivate(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* preserve original error */ }
    rmSync(temporary, { force: true });
  }
}

function secret<T>(value: string | null, label: string): T | null {
  if (value == null) return null;
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`protected GrantTap ${label} is invalid`); }
}

export class AccountStore {
  constructor(readonly root: string, readonly vault: SecretVault) {}
  pending(): PendingAuthorization | null {
    return secret<PendingAuthorization>(this.vault.load(PENDING), "pending login");
  }
  savePending(value: PendingAuthorization): void { this.vault.save(PENDING, JSON.stringify(value)); }
  clearPending(): void { this.vault.remove(PENDING); }
  saveSession(metadata: AccountMetadata, accessToken: string, refreshToken?: string): void {
    this.vault.save(SESSION, JSON.stringify({ accessToken, ...(refreshToken ? { refreshToken } : {}) }));
    atomicPrivate(join(this.root, "account.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    this.clearPending();
  }
  metadata(): AccountMetadata | null {
    const path = join(this.root, "account.json");
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, "utf8")) as AccountMetadata; }
    catch { throw new Error("GrantTap account metadata is invalid"); }
  }
  status(now = Date.now()): AccountStatus {
    const account = this.metadata();
    if (account && this.vault.load(SESSION)) {
      return { kind: account.expiresAt <= now ? "expired" : "signed_in", account };
    }
    const pending = this.pending();
    if (pending && pending.expiresAt > now) {
      const { deviceCode: _a, codeVerifier: _b, controlBase: _c, version: _d, ...safe } = pending;
      return { kind: "pending", authorization: safe };
    }
    return { kind: "signed_out" };
  }
  logout(): void {
    this.vault.remove(SESSION); this.clearPending();
    rmSync(join(this.root, "account.json"), { force: true });
    rmSync(join(this.root, "managed", "login.receipt"), { force: true });
  }
}
