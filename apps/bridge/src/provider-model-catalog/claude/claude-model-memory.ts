import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { AdvertisedModel } from '../../../../../packages/protocol/schema';
import { configDir } from '../../config/runtime/paths';
import { writePrivateFile } from '../../config/access/write-private';

/**
 * Claude Code's last picker answer, kept across monitor restarts.
 *
 * Every monitor start used to publish the four unnamed aliases to every
 * Project until its first query answered, and the phone shows the newest
 * report it holds: on 18 November the monitor restarted at 23:16:19 and the
 * owner's phone listed "Opus" without its version at 23:18. Only projected
 * picker rows are kept, under opaque digests of which Claude Code, account
 * and settings gave them; never the account payload.
 */
export type ClaudeModelAnswer = { identity: string; scope: string; rows: AdvertisedModel[] };

const MAX_BYTES = 256 * 1024;
const MAX_ANSWERS = 4;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function claudeModelMemoryPath(): string {
  return join(configDir(), 'claude-models.json');
}

const bounded = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : undefined;

function row(value: unknown, endpointId: string): AdvertisedModel | undefined {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== 'object' || typeof item.modelId !== 'string' || !ID.test(item.modelId)
    || typeof item.observedAt !== 'number' || !Number.isFinite(item.observedAt)) return undefined;
  const efforts = Array.isArray(item.supportedEfforts)
    ? item.supportedEfforts.filter((level): level is NonNullable<AdvertisedModel['supportedEfforts']>[number] =>
      typeof level === 'string' && EFFORTS.has(level)) : undefined;
  return { modelId: item.modelId, provider: 'claude', endpointId, source: 'advertised', observedAt: item.observedAt,
    label: bounded(item.label, 160), description: bounded(item.description, 240),
    ...(Number.isInteger(item.priority) ? { priority: item.priority as number } : {}),
    ...(efforts ? { supportedEfforts: efforts } : {}) };
}

function readAnswers(path: string): unknown[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size > MAX_BYTES) return [];
    const bytes = Buffer.alloc(size);
    const answers = JSON.parse(bytes.subarray(0, readSync(fd, bytes, 0, size, 0)).toString('utf8'))?.answers;
    return Array.isArray(answers) ? answers.slice(0, MAX_ANSWERS) : [];
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}

/** The last answer this Claude Code gave for this account, if one was kept. */
export function recallClaudeModels(path: string, identity: string, endpointId: string): ClaudeModelAnswer | undefined {
  const saved = readAnswers(path).find(item => (item as ClaudeModelAnswer | null)?.identity === identity) as
    { scope?: unknown; rows?: unknown } | undefined;
  if (!saved || typeof saved.scope !== 'string' || !DIGEST.test(saved.scope) || !Array.isArray(saved.rows)) return undefined;
  const rows = saved.rows.slice(0, 64).flatMap(item => row(item, endpointId) ?? []);
  return rows.length ? { identity, scope: saved.scope, rows } : undefined;
}

/** Keep the newest answer of each Claude Code and account; a failed write only costs the next restart its names. */
export function rememberClaudeModels(path: string, answer: ClaudeModelAnswer): void {
  const rows = answer.rows.slice(0, 64).map(({ modelId, label, description, priority, supportedEfforts, observedAt }) =>
    ({ modelId, label, description, priority, supportedEfforts, observedAt }));
  const others = readAnswers(path).filter(item => (item as ClaudeModelAnswer | null)?.identity !== answer.identity);
  try {
    writePrivateFile(path, JSON.stringify({ answers: [{ identity: answer.identity, scope: answer.scope, rows },
      ...others].slice(0, MAX_ANSWERS) }));
  } catch { /* The live answer is still served from memory. */ }
}
