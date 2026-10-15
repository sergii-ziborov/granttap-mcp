import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TaskDispatchReceipts } from './receipts';
import { TaskDispatch } from '../../../../packages/protocol/schema';
import { withStoreLock } from '../../../../packages/core/store-file-lock';
import { appendState, digest, readJournal, readRequest, writeRequest, syncDirectory } from './journal';
import { InboxState, RequestRecord, phaseTransitions, type InboxPhase, type StoredTaskDispatch } from './records';

type StageResult = 'staged' | 'existing' | 'conflict';
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/;

/** A receiver persists the complete operation before claiming it from the relay. */
export class TaskDispatchInbox {
  private readonly directory: string;
  private readonly receipts: TaskDispatchReceipts;
  private readonly requests = new Map<string, { size: number; modified: number; value: RequestRecord }>();
  constructor(root: string, private readonly room: string) {
    this.directory = join(root, digest(room));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    syncDirectory(dirname(root));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    syncDirectory(root);
    this.receipts = new TaskDispatchReceipts(join(this.directory, '.receipts'));
  }

  stage(input: TaskDispatch, peerPublicKey: string): StageResult {
    const job = TaskDispatch.parse(input);
    const saved = this.receipts.read(job.jobId);
    if (saved) return saved.room === this.room && saved.peerPublicKey === peerPublicKey
      && saved.jobDigest === digest(job) ? 'existing' : 'conflict';
    const paths = this.paths(job.jobId);
    return withStoreLock(paths.request, () => {
      const finished = this.receipts.read(job.jobId);
      if (finished) return finished.room === this.room && finished.peerPublicKey === peerPublicKey
        && finished.jobDigest === digest(job) ? 'existing' : 'conflict';
      if (existsSync(paths.request)) {
        const previous = this.readImmutableRequest(paths.request);
        syncDirectory(dirname(paths.request));
        return previous.room === this.room && previous.peerPublicKey === peerPublicKey
          && digest(previous.job) === digest(job) ? 'existing' : 'conflict';
      }
      const record = RequestRecord.parse({ room: this.room, peerPublicKey, job, stagedAt: Date.now() });
      writeRequest(paths.request, record);
      return 'staged';
    });
  }

  records(): StoredTaskDispatch[] {
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && safeId.test(entry.name))
      .flatMap(entry => {
        const paths = this.paths(entry.name);
        if (!existsSync(paths.request)) return [];
        return [this.load(entry.name)];
      });
  }

  pendingRecords(): StoredTaskDispatch[] {
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && safeId.test(entry.name))
      .flatMap(entry => {
        const paths = this.paths(entry.name);
        if (!existsSync(paths.request)) return [];
        const state = readJournal(paths.journal, { phase: 'staged', updatedAt: 0 }).state;
        return ['completed', 'cancelled'].includes(state.phase) ? [] : [this.load(entry.name)];
      });
  }

  status(id: string) {
    const receipt = this.receipts.read(id);
    return receipt?.state ?? (existsSync(this.paths(id).request) ? this.load(id) : undefined);
  }

  retire(id: string): boolean {
    const paths = this.paths(id);
    const retired = withStoreLock(paths.request, () => {
      if (!existsSync(paths.request)) return Boolean(this.receipts.read(id));
      const current = this.load(id);
      if (!['completed', 'cancelled'].includes(current.phase)) return false;
      const { phase, updatedAt, claimId, nativeAttemptId, nativeSessionId, code } = current;
      this.receipts.write({ room: this.room, jobId: id, jobDigest: digest(current.job),
        peerPublicKey: current.peerPublicKey,
        retainUntil: Math.max(current.job.expiresAt, updatedAt) + 7 * 86_400_000,
        state: { phase, updatedAt, claimId, nativeAttemptId, nativeSessionId, code } });
      this.requests.delete(paths.request);
      return true;
    });
    if (retired) { rmSync(paths.directory, { recursive: true, force: true }); syncDirectory(this.directory); }
    return retired;
  }

  async maintain(now = Date.now()): Promise<void> {
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !safeId.test(entry.name)) continue;
      const paths = this.paths(entry.name);
      const state = readJournal(paths.journal, { phase: 'staged', updatedAt: 0 }).state;
      if (['completed', 'cancelled'].includes(state.phase)) this.retire(entry.name);
    }
    await this.receipts.purge(now);
  }

  reserveClaim(id: string): string {
    const paths = this.paths(id);
    return withStoreLock(paths.request, () => {
      const current = this.load(id);
      if (current.claimId) return current.claimId;
      if (current.phase !== 'staged') throw new Error('A durable receiver attempt was not recorded.');
      const claimId = randomUUID();
      appendState(paths.journal, { phase: 'staged', updatedAt: current.stagedAt }, {
        phase: 'staged', updatedAt: Date.now(), claimId,
      });
      return claimId;
    });
  }

  ensureDurable(id: string): void {
    const paths = this.paths(id);
    this.readImmutableRequest(paths.request);
    syncDirectory(dirname(paths.request));
    syncDirectory(this.directory);
  }

  get(id: string): StoredTaskDispatch { return this.load(id); }

  transition(id: string, phase: InboxPhase, details: {
    nativeAttemptId?: string; nativeSessionId?: string; code?: string;
  } = {}): boolean {
    const paths = this.paths(id);
    return withStoreLock(paths.request, () => {
      if (!existsSync(paths.request)) return false;
      const current = this.load(id);
      if (!phaseTransitions[current.phase].includes(phase)
        || (phase === 'running' && !details.nativeAttemptId)) return false;
      const event = InboxState.parse({ phase, updatedAt: Date.now(),
        claimId: current.claimId, nativeAttemptId: current.nativeAttemptId, nativeSessionId: current.nativeSessionId,
        code: current.code, ...details });
      appendState(paths.journal, { phase: 'staged', updatedAt: current.stagedAt }, event);
      return true;
    });
  }

  private load(id: string): StoredTaskDispatch {
    const paths = this.paths(id);
    const request = this.readImmutableRequest(paths.request);
    if (request.room !== this.room || request.job.jobId !== id) throw new Error('Task queue scope mismatch');
    const current = readJournal(paths.journal, { phase: 'staged', updatedAt: request.stagedAt });
    return { ...request, ...current.state };
  }

  private readImmutableRequest(path: string): RequestRecord {
    const stat = statSync(path), cached = this.requests.get(path);
    if (cached && cached.size === stat.size && cached.modified === stat.mtimeMs) return cached.value;
    const value = RequestRecord.parse(readRequest(path));
    this.requests.set(path, { size: stat.size, modified: stat.mtimeMs, value });
    return value;
  }

  private paths(id: string) {
    if (!safeId.test(id)) throw new Error('Invalid task queue identity');
    const directory = join(this.directory, id);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      syncDirectory(this.directory);
    }
    return { directory, request: join(directory, 'request.json'), journal: join(directory, 'events.jsonl') };
  }
}
