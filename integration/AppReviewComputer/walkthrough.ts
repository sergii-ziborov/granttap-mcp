import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RelayClient } from '../../packages/core/relay-client';
import { writePrivateFile } from '../../apps/bridge/src/config';
import { askOpenQuestionOutcome, askYesNoOutcome } from '../../apps/mcp/src/mcp-tools/connect/relay';

type Progress = { phase: 0 | 1 | 2; updatedAt: number };
const CYCLE_MS = 10 * 60_000;

/** Only progress is retained; reviewer text and decisions are never stored here. */
export async function runReviewStep(client: RelayClient, directory: string, timeoutMs = 180_000): Promise<boolean> {
  const path = join(directory, 'review-progress.json');
  let progress: Progress = { phase: 0, updatedAt: 0 };
  if (existsSync(path)) {
    progress = JSON.parse(readFileSync(path, 'utf8')) as Progress;
    if (![0, 1, 2].includes(progress.phase) || !Number.isSafeInteger(progress.updatedAt)) {
      throw Error('Review progress needs operator inspection');
    }
  }
  if (progress.phase === 2) {
    if (Date.now() - progress.updatedAt < CYCLE_MS) return false;
    progress = { phase: 0, updatedAt: Date.now() };
  }
  const outcome = progress.phase === 0
    ? await askYesNoOutcome(client,
      'DEMO · Apple review: test an encrypted Yes/No reply. This isolated MCP walkthrough runs no shell or coding agent.', timeoutMs)
    : await askOpenQuestionOutcome(client,
      'DEMO · Type any non-sensitive test word. This tests encrypted MCP delivery; no AI model runs and your text is not logged by this walkthrough.', timeoutMs);
  if (outcome.status !== 'answered') return false;
  const phase = progress.phase === 0 ? 1 : 2;
  writePrivateFile(path, JSON.stringify({ phase, updatedAt: Date.now() }) + '\n');
  if (phase === 2) await client.send({ type: 'agent.event',
    text: 'DEMO · The isolated MCP computer received both test replies. No shell or AI model was run. The walkthrough repeats in ten minutes.',
    createdAt: Date.now() }, 'phone', { ttlMs: CYCLE_MS, reliable: false });
  return true;
}
