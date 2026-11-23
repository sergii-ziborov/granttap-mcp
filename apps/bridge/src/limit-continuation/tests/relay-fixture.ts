import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair} from '../../../../../packages/core/crypto';
import type {PeerConfig} from '../../../../../packages/core/relay-client';
import type {SessionInfo, UserMessage} from '../../../../../packages/protocol/schema';
import {NativeTaskQueueSender} from '../../task-dispatch/sender';
import {limitContinuationUnwanted, type ContinuationQueue} from '..';

export const minute = 60_000, hour = 60 * minute, day = 24 * hour;
type RelayState = 'queued' | 'accepted' | 'completed' | 'failed' | 'cancelled' | 'expired';
type RelayJob = {state: RelayState; notBefore: number; expiresAt: number; body: string};

/** A private config directory and sender store, as one computer has them across monitor restarts. */
export function isolatedComputer(t: {after: (fn: () => void) => void}): {root: string; senderRoot: string} {
  const root = mkdtempSync(join(tmpdir(), 'granttap-limit-long-')), prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, {recursive: true, force: true}); });
  return {root, senderRoot: join(root, 'native-task-queue')};
}

/**
 * The relay's rules for one job id, as `granttap-relay` keeps them: one body per id for as long as its
 * receipt is kept (a different body is a 409), a cancelled job stays cancelled, and only a queued job
 * that is due is offered. Jobs are kept until their own expiry, 30 days at most.
 */
export function fakeRelay() {
  const jobs = new Map<string, RelayJob>();
  let reachable = true;
  const answer = (id: string, job: RelayJob) =>
    Response.json({job: {id, state: job.state, notBefore: job.notBefore, expiresAt: job.expiresAt}});
  const request = async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (!reachable) throw new Error('relay unreachable');
    const id = new URL(String(input)).pathname.split('/')[2]!, method = init?.method ?? 'GET', job = jobs.get(id);
    if (method === 'PUT') {
      const body = String(init?.body);
      if (job) return job.body === body ? answer(id, job) : new Response('{}', {status: 409});
      const {notBefore, expiresAt} = JSON.parse(body) as {notBefore: number; expiresAt: number};
      const created: RelayJob = {state: 'queued', notBefore, expiresAt, body};
      jobs.set(id, created);
      return answer(id, created);
    }
    if (!job) return new Response('{}', {status: 404});
    if (method === 'DELETE') {
      if (job.state === 'queued' || job.state === 'failed') job.state = 'cancelled';
      else if (job.state !== 'cancelled') return new Response('{}', {status: 409});
    }
    return answer(id, job);
  };
  return {jobs, request: request as typeof fetch,
    reachable: (value: boolean) => { reachable = value; },
    /** Jobs the relay would offer this computer now. */
    due: (now: number) => [...jobs].filter(([, job]) => job.state === 'queued' && job.notBefore <= now && now < job.expiresAt)
      .map(([id]) => id),
    queued: () => [...jobs].filter(([, job]) => job.state === 'queued').map(([id]) => id)};
}
export type FakeRelay = ReturnType<typeof fakeRelay>;

export function machineConfig(): PeerConfig {
  const machine = generateKeyPair(), phone = generateKeyPair();
  return {relayUrl: 'wss://relay.test', room: 'r'.repeat(32), role: 'machine', deviceName: 'Fixture', senderId: 'fixture',
    myPublicKey: machine.publicKey, mySecretKey: machine.secretKey, peerPublicKey: phone.publicKey, pushAuth: 'p'.repeat(64)};
}

/**
 * One monitor process: its own sender over the computer's durable sender store, wired as the monitor
 * wires it. `sent` stands in for decryption: the relay hands back what was put on it.
 */
export function monitorProcess(senderRoot: string, config: PeerConfig, relay: FakeRelay, sent: Map<string, UserMessage>)
  : ContinuationQueue & {retryPending: () => Promise<void>} {
  const sender = new NativeTaskQueueSender({root: senderRoot, config, request: relay.request});
  return {
    submit: (scope, message, notBefore, createdAt) => {
      sent.set(message.messageId!, message);
      return sender.submit(scope, message, notBefore, createdAt);
    },
    cancel: (scope, id) => sender.cancel(scope, id),
    status: (scope, id) => sender.lookup(scope, id),
    // The task-dispatch worker uploads what was staged but not confirmed, every two seconds.
    retryPending: () => sender.retryPending(),
  };
}

/** The monitor's log lines for continuations, while the test runs. */
export function continuationLog(t: {mock: {method: (object: object, name: string, fn: (chunk: unknown) => boolean) => unknown}})
  : string[] {
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    for (const line of String(chunk).split('\n')) if (line.startsWith('[monitor] Continuation')) lines.push(line);
    return true;
  });
  return lines;
}

/**
 * The relay offers what is due and the monitor delivers what it still wants, given the chat as the newest
 * catalog shows it; returns the texts the chat got.
 */
export function offerDue(relay: FakeRelay, sent: Map<string, UserMessage>, now: number, current?: SessionInfo): string[] {
  const delivered: string[] = [];
  for (const id of relay.due(now)) {
    const message = sent.get(id)!, job = relay.jobs.get(id)!;
    if (limitContinuationUnwanted(message, () => current, now)) { job.state = 'failed'; continue; }
    job.state = 'completed';
    delivered.push(message.text);
  }
  return delivered;
}

export const limitedChat = (sessionId: string, resetsAt: number, lastActivityAt: number, window = 'seven_day',
  extra: Partial<SessionInfo> = {}): SessionInfo => ({sessionId, agent: 'claude', cwd: '/work/app', state: 'idle',
  startedAt: lastActivityAt - day, lastActivityAt, tokensSession: 0, tokensLastTurn: 0, usageLimit: {resetsAt, window}, ...extra});

/** The same chat while it works or after it finished without a limit: Claude publishes no limit then. */
export const goingChat = (chat: SessionInfo, lastActivityAt: number, state: SessionInfo['state'] = 'working'): SessionInfo => {
  const {usageLimit: _limit, ...rest} = chat;
  return {...rest, state, lastActivityAt};
};
