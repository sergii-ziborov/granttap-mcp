import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { generateKeyPair } from '../../../../../packages/core/crypto';
import type { SessionInfo, TaskDispatch, UserMessage } from '../../../../../packages/protocol/schema';
import { scheduleLimitContinuations, setAutoContinue } from '../../limit-continuation';
import { rememberPublishedCatalog } from '../../session-catalog';
import { TaskDispatchInbox } from '../../task-dispatch';
import { startTaskDispatchMonitor } from '../../task-dispatch/worker/monitor';

export const minute = 60_000, hour = 60 * minute;
/** The mocked clock starts here. */
export const NOW = Date.UTC(2026, 10, 23, 10, 0);
export const CHAT = 'limited-chat-0001';
export const RESET = NOW + 3 * hour;

/** The chat as Claude publishes it after its limit refused it a minute ago. */
export const limited = (resetsAt = RESET, refusedAt = NOW - minute, autoContinue = true): SessionInfo => ({
  sessionId: CHAT, agent: 'claude', cwd: '/work/app', state: 'idle', startedAt: NOW - 5 * hour,
  lastActivityAt: refusedAt, tokensSession: 0, tokensLastTurn: 0,
  usageLimit: { resetsAt, window: 'five_hour', autoContinue } });
/** The chat while a run goes, or after one ended without a limit. */
export const going = (state: SessionInfo['state'], at: number): SessionInfo => {
  const { usageLimit: _limit, ...rest } = limited();
  return { ...rest, state, lastActivityAt: at };
};

const wait = (ms: number) => new Promise(next => setTimeout(next, ms));

/**
 * One computer: a private config directory, the mocked clock, and the persistent monitor's task-dispatch
 * worker over a fake relay. `delivered` lists the messages the chat got; each delivery leaves the chat working
 * until the test ends its run with `chat(...)`. `start` starts another monitor process over the same directory.
 */
export function computer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'granttap-limit-queue-')), prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const own = generateKeyPair(), phone = generateKeyPair();
  const config = { relayUrl: 'ws://127.0.0.1:1', room: 'limit-queue-fixture', role: 'machine' as const,
    deviceName: 'Fixture', senderId: 'fixture', myPublicKey: own.publicKey, mySecretKey: own.secretKey,
    peerPublicKey: phone.publicKey };
  const relay = new Map<string, string>(), delivered: string[] = [], lines: string[] = [], continuations: UserMessage[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    for (const line of String(chunk).split('\n')) if (line.startsWith('[monitor] Queued messages')) lines.push(line);
    return true;
  });
  let current = limited(), stops: Array<() => void> = [];
  const offers = new Map<string, () => void>();
  let client: ReturnType<typeof fakeClient> | undefined;
  const publish = () => { if (client) rememberPublishedCatalog(client as never,
    { type: 'sessions.status', machine: 'fixture', sessions: [current], generatedAt: Date.now() }); };
  function fakeClient() {
    let incoming!: (job: TaskDispatch, peer: string) => void;
    return { room: config.room, isConnected: true, setSessionKey: () => {}, send: async () => {},
      onTaskDispatch: (callback: typeof incoming) => { incoming = callback; return () => {}; },
      offer: (job: TaskDispatch, peer: string) => incoming(job, peer) };
  }
  const start = () => {
    stops.forEach(stop => stop());
    const next = fakeClient();
    client = next; publish();
    stops = [startTaskDispatchMonitor({ config, client: next as never, isLeader: () => true, peerAllowed: () => true,
      publish: async () => {},
      remote: { get: async job => relay.get(job.jobId) ?? 'queued',
        claim: async job => { relay.set(job.jobId, 'accepted'); return true; },
        finish: async (job, outcome) => { relay.set(job.jobId, outcome); } },
      deliver: async (job, beforeStart) => {
        await beforeStart();
        const operation = job.operation as UserMessage;
        delivered.push(operation.text);
        current = going('working', Date.now()); publish();
        return 'accepted';
      } })];
  };
  t.after(() => {
    stops.forEach(stop => stop());
    if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const job = (id: string, text: string, createdAt: number, extra: Partial<TaskDispatch> = {}): TaskDispatch => ({
    type: 'task.dispatch', jobId: `phone-job-${id}`, token: 'a'.repeat(64), sessionId: CHAT, notBefore: createdAt,
    expiresAt: createdAt + 7 * 24 * hour, createdAt,
    operation: { type: 'user.message', sessionId: CHAT, agent: 'claude', messageId: `phone-message-${id}`, text, createdAt },
    ...extra });
  /** The relay offers its jobs once more; each offer runs the worker, and one already finished only does that. */
  const settle = async () => {
    for (let round = 0; round < 6; round++) { for (const offer of offers.values()) offer(); await wait(15); }
  };
  return {
    delivered, lines, continuations, relay, start,
    inbox: () => new TaskDispatchInbox(join(root, 'task-dispatch'), config.room),
    /** The chat as the next catalog shows it. */
    chat: (session: SessionInfo) => { current = session; publish(); },
    at: (time: number) => { t.mock.timers.setTime(time); publish(); },
    queue: (...jobs: TaskDispatch[]) => {
      for (const queued of jobs) {
        offers.set(queued.jobId, () => client!.offer(queued, queued.origin === 'computer' ? config.myPublicKey : phone.publicKey));
      }
    },
    job, settle,
    /** Waits for the chat to get `count` messages, offering the queue meanwhile. */
    until: async (count: number) => {
      for (let round = 0; round < 200 && delivered.length < count; round++) {
        for (const offer of offers.values()) offer(); await wait(10);
      }
      assert.equal(delivered.length, count, `delivered: ${JSON.stringify(delivered)}`);
    },
    /** Schedules the chat's continuation as the catalog loop does; returns it as the relay would offer it. */
    continuation: async (off = false): Promise<TaskDispatch | undefined> => {
      if (off) setAutoContinue(CHAT, false);
      await scheduleLimitContinuations([current], { submit: async (_scope, message) => { continuations.push(message); },
        cancel: async () => {} }, Date.now());
      const message = continuations.at(-1);
      if (!message) return undefined;
      return { type: 'task.dispatch', origin: 'computer', jobId: message.messageId!, token: 'b'.repeat(64), sessionId: CHAT,
        notBefore: RESET + minute, expiresAt: RESET + 7 * 24 * hour, createdAt: message.createdAt, operation: message };
    },
  };
}
