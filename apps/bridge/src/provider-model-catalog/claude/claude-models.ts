import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import type { AdvertisedModel } from '../../../../../packages/protocol/schema';

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

export type ClaudeModelQuery = { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv;
  onFailure?: (reason: string) => void };

/** By hand it answered in 0.2–7 s; on 2–3 November the monitor's own query ran out of 30 s twice beside 89–140 Codex processes. */
export const CLAUDE_MODEL_QUERY_TIMEOUT_MS = 60_000;

/**
 * No prompt, saved session, hooks, MCP children or tools. Never persists the account payload.
 */
export async function readClaudeModels(binary: string, endpointId: string,
  options: ClaudeModelQuery = {}): Promise<AdvertisedModel[]> {
  return new Promise(resolve => {
    const timeoutMs = options.timeoutMs ?? CLAUDE_MODEL_QUERY_TIMEOUT_MS;
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
    // A monitor whose event loop was held past the deadline reads the answer already waiting in the pipe first.
    const timeout = setTimeout(() => setImmediate(() => stop([], `timed out after ${timeoutMs / 1000} s`)), timeoutMs);
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
