import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TaskTransferNotice } from '../../../../../packages/protocol/schema';
import { configDir } from '../../config/runtime/paths';
import { writePrivateFile } from '../../config/access/write-private';
import { withStoreLock } from '../../../../../packages/core/store-file-lock';

const Notice = TaskTransferNotice;
const noticeTime = (notice: TransferNotice) => notice.queuedAt ?? notice.acceptedAt ?? 0;
export type TransferNotice = import('../../../../../packages/protocol/schema').TaskTransferNotice;
export type ContinuationConsent = { sessionId: string; projectId: string; taskId: string; capsuleHash: string };

/** A per-transfer confirmation permits parallel branches without modifying provider policy. */
export class TransferContinuations {
  constructor(private readonly directory = join(configDir(), 'transfer-continuations')) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  notice(sessionId: string): TransferNotice | undefined {
    const alias = this.aliasPath(sessionId);
    if (existsSync(alias)) {
      if (statSync(alias).size > 1_024) throw new Error('The transfer alias is invalid.');
      const target = JSON.parse(readFileSync(alias, 'utf8')).sourceSessionId;
      if (typeof target !== 'string' || target === sessionId) throw new Error('The transfer alias scope is invalid.');
      sessionId = target;
    }
    const path = this.path(sessionId);
    if (!existsSync(path)) return undefined;
    if (statSync(path).size > 4_096) throw new Error('The transfer notice is invalid.');
    const value = Notice.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (value.sourceSessionId !== sessionId) throw new Error('The transfer notice scope is invalid.');
    return value;
  }

  record(input: TransferNotice, nativeSessionId?: string): void {
    const notice = Notice.parse(input), path = this.path(notice.sourceSessionId);
    withStoreLock(path, () => {
      const previous = this.notice(notice.sourceSessionId);
      if (nativeSessionId && nativeSessionId !== notice.sourceSessionId) {
        const alias = this.aliasPath(nativeSessionId);
        writeNotice(alias, { sourceSessionId: notice.sourceSessionId });
      }
      const sameTransfer = previous?.capsuleHash === notice.capsuleHash;
      const promotion = sameTransfer && previous?.phase === 'pending' && notice.phase !== 'pending';
      if (previous && !promotion && noticeTime(previous) >= noticeTime(notice)) return;
      const consent = sameTransfer ? previous?.continuedAt : undefined;
      writeNotice(path, { ...notice,
        queuedAt: notice.queuedAt ?? (sameTransfer ? previous?.queuedAt : undefined),
        targetComputerId: notice.targetComputerId ?? (sameTransfer ? previous?.targetComputerId : undefined),
        targetProvider: notice.targetProvider ?? (sameTransfer ? previous?.targetProvider : undefined),
        continuedAt: consent == null ? undefined : Math.max(consent, (notice.acceptedAt ?? 0) + 1) });
    });
  }

  continue(consent: ContinuationConsent): boolean {
    const path = this.path(consent.sessionId);
    return withStoreLock(path, () => {
      const notice = this.notice(consent.sessionId);
      if (!notice || notice.sourceSessionId !== consent.sessionId
        || notice.projectId !== consent.projectId || notice.taskId !== consent.taskId
        || notice.capsuleHash !== consent.capsuleHash) return false;
      writeNotice(path, { ...notice,
        continuedAt: notice.continuedAt ?? Math.max(Date.now(), noticeTime(notice) + 1, (notice.acceptedAt ?? 0) + 1) });
      return true;
    });
  }

  blockReason(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    const notice = this.notice(sessionId);
    return notice && !notice.continuedAt
      ? notice.phase === 'pending'
        ? 'This task is queued for transfer. Wait for the destination, or choose Continue anyway in GrantTap to run a parallel branch here.'
        : 'This task was transferred. Continue in its destination chat, or choose Continue anyway in GrantTap to run a parallel branch here.'
      : undefined;
  }

  /** Only an uncommitted draft or an authenticated rejection may withdraw a queued transfer. */
  withdrawPending(scope: ContinuationConsent): boolean {
    const path = this.path(scope.sessionId);
    return withStoreLock(path, () => {
      const notice = this.notice(scope.sessionId);
      if (notice?.phase !== 'pending' || notice.sourceSessionId !== scope.sessionId
        || notice.projectId !== scope.projectId || notice.taskId !== scope.taskId
        || notice.capsuleHash !== scope.capsuleHash) return false;
      unlinkSync(path); syncNoticeDirectory(path); return true;
    });
  }

  private path(sessionId: string): string {
    if (!sessionId || sessionId.length > 256) throw new Error('Invalid continuation scope.');
    return join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  }

  private aliasPath(sessionId: string): string {
    return this.path(sessionId).replace(/\.json$/, '.alias.json');
  }
}

function writeNotice(path: string, value: unknown): void {
  writePrivateFile(path, JSON.stringify(value));
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  syncNoticeDirectory(path);
}

function syncNoticeDirectory(path: string): void {
  if (process.platform !== 'win32') {
    const parent = openSync(dirname(path), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}

let local: { root: string; store: TransferContinuations } | undefined;
export function localTransferContinuations(): TransferContinuations {
  const root = join(configDir(), 'transfer-continuations');
  if (local?.root !== root) local = { root, store: new TransferContinuations(root) };
  return local.store;
}

export function acceptTransferContinuation(input: ContinuationConsent): boolean {
  return localTransferContinuations().continue(input);
}
