import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AdvertisedModel } from '../../../../packages/protocol/schema';
import { installedClaudeBinary } from '../providers/claude-bin';
import { claudeAccountScope } from './claude-account-scope';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const text = (value: unknown) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 240) || undefined : undefined;

/** Initialize returns the CLI's picker metadata before any user message or model request. */
export function projectClaudeModels(value: unknown, endpointId: string, now: number): AdvertisedModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 64).flatMap((row, priority) => {
    if (!row || typeof row !== 'object' || typeof row.value !== 'string'
      || row.value === 'default' || !ID.test(row.value) || seen.has(row.value)) return [];
    seen.add(row.value);
    const supportedEfforts = Array.isArray(row.supportedEffortLevels)
      ? [...new Set<NonNullable<AdvertisedModel["supportedEfforts"]>[number]>(row.supportedEffortLevels.filter((level: unknown) => typeof level === 'string' && EFFORTS.has(level)))]
      : row.supportsEffort === true ? undefined : [];
    return [{ modelId: row.value, label: text(row.displayName)?.slice(0, 160), description: text(row.description),
      provider: 'claude' as const, endpointId, observedAt: now, source: 'advertised' as const,
      priority, supportedEfforts }];
  });
}

/**
 * `--model` documents these aliases, and the installed CLI resolves each to a
 * concrete version, so none is invented here. The descriptions are the phone's
 * own localization keys.
 */
const ALIASES: ReadonlyArray<{ modelId: string; label: string; description: string }> = [
  { modelId: 'opus', label: 'Opus', description: 'Latest Opus alias · complex reasoning tasks.' },
  { modelId: 'sonnet', label: 'Sonnet', description: 'Latest Sonnet alias · everyday coding tasks.' },
  { modelId: 'haiku', label: 'Haiku', description: 'Latest Haiku alias · fast, efficient simple tasks.' },
  { modelId: 'fable', label: 'Fable',
    description: 'Fable alias · hardest and longest-running tasks. May require usage credits.' },
];

function claudeAliasRows(endpointId: string, now: number): AdvertisedModel[] {
  return ALIASES.map((alias, priority) => ({ ...alias, provider: 'claude' as const, endpointId,
    observedAt: now, source: 'advertised' as const, priority }));
}

export type ClaudeModelQuery = { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv;
  onFailure?: (reason: string) => void };

/**
 * No prompt, saved session, hooks, MCP children or tools. Never persists the account payload.
 * Startup took 2–7 s by hand on an idle Mac; a busy monitor runs several CLIs beside it.
 */
export async function readClaudeModels(binary: string, endpointId: string,
  options: ClaudeModelQuery = {}): Promise<AdvertisedModel[]> {
  return new Promise(resolve => {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const child = spawn(binary, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}', '--tools', ''],
    { cwd: options.cwd ?? homedir(), env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let bytes = 0, done = false, stderr = '';
    const stop = (rows: AdvertisedModel[], failure: string) => {
      if (done) return;
      done = true; clearTimeout(timeout); lines.close(); child.stdin.destroy();
      child.kill('SIGTERM');
      const force = setTimeout(() => { child.kill('SIGKILL'); }, 1_000); force.unref();
      child.once('exit', () => clearTimeout(force));
      const said = text(stderr.slice(-480));
      if (!rows.length) options.onFailure?.(said ? `${failure}: ${said}` : failure);
      resolve(rows);
    };
    const timeout = setTimeout(() => stop([], `timed out after ${timeoutMs / 1000} s`), timeoutMs);
    child.on('error', error => stop([], `could not start (${(error as NodeJS.ErrnoException).code ?? error.name})`));
    // `close` follows the last stderr bytes, so the reason a CLI gave on its way out is kept.
    child.on('close', (code, signal) => stop([], `exited with ${signal ?? `code ${code}`} before answering`));
    child.stdin.on('error', () => stop([], 'closed its input before answering'));
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4_000); });
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 512_000) stop([], 'answered with more than 512 KB'); });
    lines.on('line', line => {
      if (done || line.length > 512_000) return;
      try {
        const value = JSON.parse(line);
        if (value.type === 'control_response' && value.response?.request_id === 'granttap-model-catalog') {
          if (value.response.subtype !== 'success') {
            stop([], `initialize failed (${text(value.response.error) ?? 'no reason given'})`);
          } else stop(projectClaudeModels(value.response.response?.models, endpointId, Date.now()), 'listed no usable models');
        }
      } catch { /* A non-protocol line does not advertise models. */ }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'granttap-model-catalog',
      request: { subtype: 'initialize' } }) + '\n');
  });
}

let scope = '', report: AdvertisedModel[] = [], checkedAt = 0, recorded = '';
let pending: Promise<void> | undefined;
const stderrLog = (line: string) => { process.stderr.write(`[granttap] ${line}\n`); };

/**
 * Nonblocking, one bounded metadata process at a time, shared by all catalog readers.
 * Live picker rows win; an installed Claude Code without them still offers its aliases.
 */
export function cachedClaudeModels(endpointId: string, env = process.env, home = homedir(),
  log: (line: string) => void = stderrLog): AdvertisedModel[] {
  const binary = installedClaudeBinary(home, env);
  if (!binary) return [];
  const config = env.GRANTTAP_CLAUDE_DIR ?? env.NODVOX_CLAUDE_DIR ?? env.CLAUDE_CONFIG_DIR;
  const root = config ?? join(home, '.claude');
  const key = [endpointId, binary.path, binary.version, root,
    modified(join(root, '.credentials.json')), claudeAccountScope(config ? join(root, '.claude.json') : join(home, '.claude.json')),
    modified(join(root, 'settings.json')), modified(join(root, 'settings.local.json'))].join('\u001f');
  if (key !== scope) { scope = key; report = []; checkedAt = 0; }
  if (!pending && Date.now() - checkedAt > (report.length ? 10 : 2) * 60_000) {
    checkedAt = Date.now();
    const onFailure = (reason: string) => {
      if (reason !== recorded) log(`Claude Code model list unavailable, offering its aliases: ${reason}`);
      recorded = reason;
    };
    pending = readClaudeModels(binary.path, endpointId, { env: config ? { ...env, CLAUDE_CONFIG_DIR: config } : env, onFailure })
      .then(rows => {
        if (rows.length) recorded = '';
        if (scope === key) report = rows;
      }).finally(() => { pending = undefined; });
  }
  const live = report.filter(row => Date.now() - row.observedAt <= 15 * 60_000);
  return live.length ? live : claudeAliasRows(endpointId, Date.now());
}

function modified(path: string): string {
  try { const info = statSync(path); return `${info.mtimeMs}:${info.ctimeMs}`; } catch { return ''; }
}
