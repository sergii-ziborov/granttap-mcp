import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdvertisedModel } from '../../../../../packages/protocol/schema';
import { installedClaudeBinary } from '../../providers/claude-bin';
import { claudeAccountScope } from './claude-account-scope';
import { claudeModelMemoryPath, recallClaudeModels, rememberClaudeModels } from './claude-model-memory';
import { readClaudeModels } from './claude-models';

/** A good answer is asked again after ten minutes and stays offered for an hour, so one failed query never empties the list. */
export const CLAUDE_MODEL_REFRESH_MS = 10 * 60_000;
export const CLAUDE_MODEL_KEEP_MS = 60 * 60_000;
/** A failed query is retried after 15 s, then every two minutes. */
export const CLAUDE_MODEL_RETRY_MS: readonly number[] = [15_000, 2 * 60_000];

/**
 * `--model` documents these aliases, and the installed CLI resolves each to a
 * concrete version. Their names come from that CLI's own last answer when this
 * Claude Code and account gave one; otherwise no version is invented. The
 * descriptions are the phone's own localization keys.
 */
const ALIASES: ReadonlyArray<{ modelId: string; label: string; description: string }> = [
  { modelId: 'opus', label: 'Opus', description: 'Latest Opus alias · complex reasoning tasks.' },
  { modelId: 'sonnet', label: 'Sonnet', description: 'Latest Sonnet alias · everyday coding tasks.' },
  { modelId: 'haiku', label: 'Haiku', description: 'Latest Haiku alias · fast, efficient simple tasks.' },
  { modelId: 'fable', label: 'Fable',
    description: 'Fable alias · hardest and longest-running tasks. May require usage credits.' },
];

export type ClaudeModelCacheOptions = { now?: () => number; memory?: string; timeoutMs?: number };
type Log = (line: string) => void;

const state = { scope: '', identity: '', checkedAt: 0, failures: 0, reason: '' };
/** The answer offered for this scope: this one's, or the same Claude Code and account's before its settings changed. */
let report: AdvertisedModel[] = [];
/** The latest answer this Claude Code and account gave, whatever its age: the aliases' names. */
let named: AdvertisedModel[] = [];
let pending: Promise<void> | undefined;

const stderrLog: Log = line => { process.stderr.write(`[granttap] ${line}\n`); };
const digest = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function modified(path: string): string {
  try { const info = statSync(path); return `${info.mtimeMs}:${info.ctimeMs}`; } catch { return ''; }
}

const readable = new Map<string, string>();

/** Claude Code rewrites `.claude.json` all the time; a read that catches it half-written is not another account. */
function account(file: string): string {
  const scope = claudeAccountScope(file);
  if (scope !== 'unavailable') readable.set(file, scope);
  return readable.get(file) ?? scope;
}

function nextCheck(): number {
  if (state.failures > 0) return CLAUDE_MODEL_RETRY_MS[Math.min(state.failures, CLAUDE_MODEL_RETRY_MS.length) - 1]!;
  return report.length ? CLAUDE_MODEL_REFRESH_MS : 0;
}

/** Another account never inherits rows; changed settings keep the old answer until the new one arrives. */
function adopt(scope: string, identity: string, endpointId: string, memory: string): void {
  if (identity !== state.identity) { report = []; named = []; }
  Object.assign(state, { scope, identity, checkedAt: 0, failures: 0, reason: '' });
  const saved = recallClaudeModels(memory, identity, endpointId);
  if (!saved) return;
  if (!named.length) named = saved.rows;
  if (!report.length && saved.scope === scope) report = saved.rows;
}

type Query = { memory: string; now: () => number; log: Log; timeoutMs?: number };

function query(binary: string, endpointId: string, env: NodeJS.ProcessEnv, { memory, now, log, timeoutMs }: Query): void {
  state.checkedAt = now();
  const { scope, identity } = state;
  let failure = 'listed no usable models';
  pending = readClaudeModels(binary, endpointId, { env, timeoutMs, onFailure: reason => { failure = reason; } })
    .then(rows => {
      if (state.scope !== scope) return;
      if (rows.length) {
        const at = now();
        report = named = rows.map(row => ({ ...row, observedAt: at }));
        Object.assign(state, { failures: 0, reason: '' });
        rememberClaudeModels(memory, { identity, scope, rows: report });
        return;
      }
      state.failures += 1;
      state.reason = failure;
      log(`Claude Code model list query failed (${state.failures} in a row, next in ${nextCheck() / 1000} s`
        + `${report.length ? '; its last answer stays offered' : ''}): ${failure}`);
    }).finally(() => { pending = undefined; });
}

function aliasRows(endpointId: string, observedAt: number): AdvertisedModel[] {
  return ALIASES.map((alias, priority) => {
    const answer = named.find(row => row.modelId === alias.modelId && row.label);
    return { ...alias, provider: 'claude' as const, endpointId, observedAt, source: 'advertised' as const, priority,
      ...(answer ? { label: answer.label, description: answer.description ?? alias.description,
        ...(answer.supportedEfforts ? { supportedEfforts: answer.supportedEfforts } : {}) } : {}) };
  });
}

/**
 * Nonblocking, one bounded metadata process at a time, shared by all catalog readers.
 * Live picker rows win; an installed Claude Code without them still offers its aliases,
 * and every catalog read that does so says why in one stderr line (the monitor log).
 */
export function cachedClaudeModels(endpointId: string, env = process.env, home = homedir(),
  log: Log = stderrLog, options: ClaudeModelCacheOptions = {}): AdvertisedModel[] {
  const binary = installedClaudeBinary(home, env);
  if (!binary) return [];
  const now = options.now ?? Date.now, memory = options.memory ?? claudeModelMemoryPath();
  const config = env.GRANTTAP_CLAUDE_DIR ?? env.NODVOX_CLAUDE_DIR ?? env.CLAUDE_CONFIG_DIR;
  const root = config ?? join(home, '.claude');
  const identity = digest([endpointId, binary.path, binary.version, root,
    account(config ? join(root, '.claude.json') : join(home, '.claude.json'))]);
  const scope = digest([identity, modified(join(root, '.credentials.json')),
    modified(join(root, 'settings.json')), modified(join(root, 'settings.local.json'))]);
  if (scope !== state.scope) adopt(scope, identity, endpointId, memory);
  if (!pending && now() - state.checkedAt >= nextCheck()) {
    query(binary.path, endpointId, config ? { ...env, CLAUDE_CONFIG_DIR: config } : env,
      { memory, now, log, timeoutMs: options.timeoutMs });
  }
  const at = now();
  const live = report.filter(row => at - row.observedAt <= CLAUDE_MODEL_KEEP_MS);
  if (live.length) return live;
  const rows = aliasRows(endpointId, at);
  const why = [report.length ? `its last answer is more than ${CLAUDE_MODEL_KEEP_MS / 60_000} min old` : '',
    state.reason || (report.length ? '' : 'its first answer has not arrived')].filter(Boolean).join('; ');
  log(`Claude Code model list unavailable, offering its aliases as ${rows.map(row => row.label).join(', ')}: ${why}`);
  return rows;
}
