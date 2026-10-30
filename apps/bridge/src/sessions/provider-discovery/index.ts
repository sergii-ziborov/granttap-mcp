import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { loadRuntimeConfig } from '../../config';
import { timedProviderScan, timedProviderScanAsync } from '../../machine-load/mcp/scan-cost';
import { scanClaude, scanClaudeCooperatively } from '../scan/claude';
import { scanCodex, scanCodexCooperatively } from '../scan/codex';
import { scanCursor } from '../cursor';
import { scanGrok } from '../scan/grok';
import { MAX_FILES } from '../support/common';

export type ProviderScan = ReturnType<typeof scanClaude>;

function emptyScan(): ProviderScan {
  return { sessions: [], tokensRecent: 0 };
}

/**
 * Explicit provider roots isolate fixtures and diagnostics from real user logs.
 * In normal operation (no overrides) every installed provider is scanned.
 */
function providerReaders(maxFiles: number) {
  const enabled = loadRuntimeConfig().providerSettings;
  const explicit = {
    claude: Boolean(process.env.GRANTTAP_CLAUDE_PROJECTS_DIR || process.env.NODVOX_CLAUDE_PROJECTS_DIR),
    codex: Boolean(process.env.GRANTTAP_CODEX_SESSIONS_DIR || process.env.NODVOX_CODEX_SESSIONS_DIR),
    cursor: Boolean(process.env.GRANTTAP_CURSOR_TRANSCRIPTS_DIR || process.env.GRANTTAP_CURSOR_STATE_DB),
    grok: Boolean(process.env.GRANTTAP_GROK_SESSIONS_DIR || process.env.GROK_HOME),
  };
  const isolated = Object.values(explicit).some(Boolean);
  const cooperative = { claude: scanClaudeCooperatively, codex: scanCodexCooperatively,
    cursor: async (limit: number) => scanCursor(limit), grok: async (limit: number) => scanGrok(limit) };
  return Object.entries({ claude: scanClaude, codex: scanCodex, cursor: scanCursor, grok: scanGrok })
    .map(([agent, read]) => {
      const key = agent as keyof typeof explicit;
      return { agent, read: () => read(maxFiles), cooperative: () => cooperative[key](maxFiles),
        enabled: enabled[key] && (!isolated || explicit[key]) };
    });
}

export function providerScans(maxFiles = MAX_FILES): ProviderScan[] {
  return providerReaders(maxFiles).map(reader => reader.enabled
    ? timedProviderScan(reader.agent, reader.read) : emptyScan());
}

const pending = new Map<string, Promise<ProviderScan[]>>();

/** Share one native read only while it is running; subsequent refreshes stay fresh. */
export function cooperativeProviderScans(maxFiles = MAX_FILES): Promise<ProviderScan[]> {
  const readers = providerReaders(maxFiles);
  // Hash the complete process scope rather than retaining environment values.
  const scope = [maxFiles, readers.map(({ agent, enabled }) => [agent, enabled]),
    Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right))];
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const active = pending.get(key);
  if (active) return active;
  const next = (async () => {
    const scans: ProviderScan[] = [];
    for (const reader of readers) {
      await setImmediate();
      scans.push(reader.enabled ? await timedProviderScanAsync(reader.agent, reader.cooperative) : emptyScan());
    }
    return scans;
  })().finally(() => { if (pending.get(key) === next) pending.delete(key); });
  pending.set(key, next);
  return next;
}

