import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../../../../bridge/src/config/runtime/paths';
import { writePrivateFile } from '../../../../bridge/src/config/access/write-private';

type Pending = { id: string; confirmation: string; challenge: string; state: string; expires: number };
type Grant = { digest: string; expires: number };
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');

/** Desktop-only grants are never accepted on the provider MCP OAuth surface. */
export class DesktopNativeAccess {
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Pending>();
  constructor(private readonly path = join(configDir(), 'desktop-grants.json'),
    private readonly now = Date.now) {}

  begin(challenge: string, state: string): Pending {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9_-]{8,128}$/.test(state)) {
      throw new Error('Invalid native authorization');
    }
    for (const [id, row] of this.pending) if (row.expires <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 16) throw new Error('Authorization capacity');
    const row = { id: random(), confirmation: random(), challenge, state, expires: this.now() + 300_000 };
    this.pending.set(row.id, row);
    return row;
  }

  approve(id: string, confirmation: string): string {
    const row = this.pending.get(id);
    if (!row || row.confirmation !== confirmation || row.expires <= this.now()) {
      throw new Error('Authorization expired or unconfirmed');
    }
    this.pending.delete(id);
    for (const [code, pending] of this.codes) if (pending.expires <= this.now()) this.codes.delete(code);
    const code = random();
    this.codes.set(code, row);
    return code;
  }

  exchange(code: string, verifier: string): string {
    const row = this.codes.get(code);
    this.codes.delete(code);
    if (!row || row.expires <= this.now() || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)
      || digest(verifier) !== row.challenge) throw new Error('Invalid native code');
    const token = random();
    const grants = this.grants().filter(grant => grant.expires > this.now()).slice(-7);
    grants.push({ digest: digest(token), expires: this.now() + 30 * 24 * 3_600_000 });
    writePrivateFile(this.path, JSON.stringify(grants));
    return token;
  }

  verify(token: string): boolean {
    return /^[A-Za-z0-9_-]{43}$/.test(token) && this.grants().some(grant =>
      grant.expires > this.now() && grant.digest === digest(token));
  }

  private grants(): Grant[] {
    try {
      if (!existsSync(this.path)) return [];
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(value) && value.length <= 8 && value.every(row =>
        typeof row.digest === 'string' && Number.isFinite(row.expires)) ? value : [];
    } catch { return []; }
  }
}
