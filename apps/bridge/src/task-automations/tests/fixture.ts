import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutomationSchedule, SessionInfo, UserMessage } from '../../../../../packages/protocol/schema';
import { TaskAutomationControls, type AutomationScope } from '../controls';
import { AutomationRunner, chatHold, type ChatSnapshot } from '../runner';
import type { StoredAutomation } from '../store';

export const minute = 60_000, hour = 60 * minute, day = 24 * hour;

/** A private config directory for one computer, kept across monitor restarts within the test. */
export function isolatedComputer(t: { after: (fn: () => void) => void }): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'granttap-automations-')), prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path: join(root, 'task-automations.json') };
}

export function chat(sessionId: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionId, agent: 'claude', projectId: 'project', taskId: 'task', state: 'idle', startedAt: 1, lastActivityAt: 2,
    tokensSession: 0, tokensLastTurn: 0, ...patch };
}

export const scopeOf = (session: SessionInfo, sessions = [session.sessionId]): AutomationScope => ({ sessions,
  chat: { sessionId: session.sessionId, agent: session.agent as 'claude', projectId: session.projectId, taskId: session.taskId } });

/**
 * One computer with a fake clock: the chats it lists (`chats`, freshly catalogued at every look), the
 * readings of its accounts, the monitor's own runs and what each chat was sent. `start()` is a new
 * monitor process on the same saved state.
 */
export function fakeComputer(path: string, start: number) {
  const world = { now: start, chats: new Map<string, SessionInfo>(), inFlight: new Set<string>(),
    queued: new Map<string, number>(), continuations: new Set<string>(), readings: [] as ChatSnapshot['readings'],
    updating: false, refuse: undefined as string | undefined, sent: [] as UserMessage[], lines: [] as string[] };
  const snapshot = (row: StoredAutomation): ChatSnapshot => ({ agent: row.agent, session: world.chats.get(row.sessionId),
    catalogAt: world.now, inFlight: world.inFlight.has(row.sessionId), paused: false,
    queued: world.queued.get(row.sessionId) ?? 0, updating: world.updating,
    continuation: world.continuations.has(row.sessionId), readings: world.readings });
  const start_ = () => new AutomationRunner({ path, now: () => world.now, log: line => world.lines.push(line),
    hold: row => chatHold(snapshot(row), world.now),
    deliver: async message => {
      if (world.refuse) return world.refuse;
      world.sent.push(message);
      return undefined;
    } });
  let runner = start_();
  const controls = new TaskAutomationControls({ path, now: () => world.now });
  return {
    world, controls,
    restart: () => { runner = start_(); },
    /** One pass of the monitor at `at`, deliveries included. */
    async pass(at = world.now) { world.now = at; await runner.tick(); await runner.settled(); },
    /** The phone's request and the computer's answer. */
    async ask(session: SessionInfo, action?: unknown, requestId = `request-${Math.random()}`) {
      const answers: any[] = [];
      await controls.handle({ type: 'task.automations', requestId, sessionId: session.sessionId, createdAt: world.now,
        ...(action ? { action: action as any } : {}) }, { controller: 'phone', scope: scopeOf(session),
        send: async result => { answers.push(result); } });
      return answers[0];
    },
    async create(session: SessionInfo, schedule: AutomationSchedule, prompt = 'Summarise what changed.') {
      const answer = await this.ask(session, { kind: 'create', draft: { name: 'Fixture', prompt, schedule } });
      if (answer?.phase !== 'completed') throw new Error(`create failed: ${answer?.message}`);
      return answer.automations.find((row: any) => row.id === answer.changedId);
    },
  };
}
