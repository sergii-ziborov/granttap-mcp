import { closeSync, fstatSync, openSync } from 'node:fs';
import type { ChildThreadInfo, SessionInfo } from '../../../../../../../packages/protocol/schema';
import { safeParse } from '../../../support/common';
import { createClaudeCapabilityCollector } from '../activity';
import { createClaudeChildSummary } from '../shared';
import { readTranscriptRows } from '../transcript-reading';

type ChildRead = { summary: ChildThreadInfo; observations: ReturnType<ReturnType<typeof createClaudeCapabilityCollector>['snapshot']> };

/** Two bounded passes preserve the native child identity without retaining its whole transcript. */
export function* readClaudeChild(path: string, parent: SessionInfo): Generator<void, ChildRead | undefined> {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return undefined; }
  try {
    const size = fstatSync(fd).size;
    const summary = createClaudeChildSummary(path, parent.sessionId);
    yield* readTranscriptRows(fd, { offset: 0, tail: Buffer.alloc(0) }, size, line => {
      const row = line ? safeParse(line) : null;
      if (!row) return false;
      summary.add(row); return true;
    });
    const child = summary.finish();
    const collector = createClaudeCapabilityCollector(() => parent, child.threadId);
    yield* readTranscriptRows(fd, { offset: 0, tail: Buffer.alloc(0) }, size, line => {
      const row = line ? safeParse(line) : null;
      if (!row) return false;
      collector.add(row); return true;
    });
    return { summary: child, observations: collector.snapshot() };
  } catch { return undefined; }
  finally { closeSync(fd); }
}
