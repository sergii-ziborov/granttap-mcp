import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const fields = ['accountUuid', 'organizationUuid', 'billingType', 'seatTier',
  'organizationRole', 'workspaceRole', 'organizationType', 'organizationRateLimitTier',
  'userRateLimitTier', 'hasExtraUsageEnabled', 'claudeCodeTrialEndsAt'];
const cache = new Map<string, { revision: string; digest: string }>();

function revision(file: string): string {
  const stat = statSync(file, { bigint: true });
  if (!stat.isFile() || stat.size > 4n * 1024n * 1024n) throw Error('Native account metadata unavailable');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Startup counters and profile refresh dates do not change the model account. */
export function claudeAccountScope(file: string): string {
  try {
    const before = revision(file), cached = cache.get(file);
    if (cached?.revision === before) return cached.digest;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const account = value?.oauthAccount;
    const scope = [fields.map(field => account?.[field]),
      typeof value?.primaryApiKey === 'string' ? value.primaryApiKey : undefined];
    // Keep only an opaque digest. No account fields, API keys or config text are retained.
    const digest = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    cache.delete(file);
    if (revision(file) === before) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cache.set(file, { revision: before, digest });
    }
    return digest;
  } catch { cache.delete(file); return 'unavailable'; }
}
