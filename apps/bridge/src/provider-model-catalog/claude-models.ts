import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { AdvertisedModel } from '../../../../packages/protocol/schema';
import { resolveClaudeBinary } from '../providers/claude-bin';

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

/** No prompt, saved session, hooks, MCP children or tools. Never persists the account payload. */
export async function readClaudeModels(binary: string, endpointId: string,
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<AdvertisedModel[]> {
  return new Promise(resolve => {
    const child = spawn(binary, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}', '--tools', ''],
    { cwd: options.cwd ?? homedir(), env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let bytes = 0, done = false;
    const stop = (rows: AdvertisedModel[] = []) => {
      if (done) return;
      done = true; clearTimeout(timeout); lines.close(); child.stdin.destroy();
      child.kill('SIGTERM');
      const force = setTimeout(() => { child.kill('SIGKILL'); }, 1_000); force.unref();
      child.once('exit', () => clearTimeout(force));
      resolve(rows);
    };
    const timeout = setTimeout(() => stop(), options.timeoutMs ?? 10_000);
    child.on('error', () => stop()); child.on('exit', () => stop());
    child.stdin.on('error', () => stop());
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 512_000) stop(); });
    lines.on('line', line => {
      if (done || line.length > 512_000) return;
      try {
        const value = JSON.parse(line);
        if (value.type === 'control_response' && value.response?.request_id === 'granttap-model-catalog') {
          stop(value.response.subtype === 'success'
            ? projectClaudeModels(value.response.response?.models, endpointId, Date.now()) : []);
        }
      } catch { /* A non-protocol line does not advertise models. */ }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'granttap-model-catalog',
      request: { subtype: 'initialize' } }) + '\n');
  });
}

let scope = '', report: AdvertisedModel[] = [], checkedAt = 0;
let pending: Promise<void> | undefined;

/** Nonblocking, one bounded metadata process at a time, shared by all catalog readers. */
export function cachedClaudeModels(endpointId: string, env = process.env): AdvertisedModel[] {
  const binary = resolveClaudeBinary(homedir(), env);
  const config = env.GRANTTAP_CLAUDE_DIR ?? env.NODVOX_CLAUDE_DIR ?? env.CLAUDE_CONFIG_DIR;
  const root = config ?? join(homedir(), '.claude');
  const key = [endpointId, binary.path, binary.version, root,
    modified(join(root, '.credentials.json')), modified(config ? join(root, '.claude.json') : join(homedir(), '.claude.json'))].join('\u001f');
  if (key !== scope) { scope = key; report = []; checkedAt = 0; }
  if (binary && !pending && Date.now() - checkedAt > (report.length ? 10 : 2) * 60_000) {
    checkedAt = Date.now();
    pending = readClaudeModels(binary.path, endpointId, { env: config ? { ...env, CLAUDE_CONFIG_DIR: config } : env }).then(rows => {
      if (scope === key) report = rows;
    }).finally(() => { pending = undefined; });
  }
  return report.filter(row => Date.now() - row.observedAt <= 15 * 60_000);
}

function modified(path: string): string {
  try { const info = statSync(path); return `${info.mtimeMs}:${info.ctimeMs}`; } catch { return ''; }
}
