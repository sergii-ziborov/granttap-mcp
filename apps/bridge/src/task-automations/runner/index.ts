import { createHash, randomBytes } from 'node:crypto';
import { UserMessage } from '../../../../../packages/protocol/schema';
import { automationLine } from '../log';
import { automationsPath, updateAutomations, type StoredAutomation } from '../store';
import { planAutomations, type ChatHold, type ClaimedRun, type Plan } from './plan';

export { CATCH_UP_MS, LONGEST_WAIT_MS, type ChatHold } from './plan';
export { chatHold, limitHold, FRESH_CATALOG_MS, type ChatSnapshot } from './readiness';

export const AUTOMATION_MESSAGE_PREFIX = 'automation-';
const NOT_TAKEN = 'The chat did not take the message.';

export type RunnerOptions = {
  /** Why the chat cannot take a run now (`chatHold` of what the monitor knows), or `undefined` when free. */
  hold: (row: StoredAutomation, now: number) => ChatHold | undefined;
  /** Hands the message to the chat as a phone turn. Resolves to why it was refused, `undefined` once taken. */
  deliver: (message: UserMessage, row: StoredAutomation) => Promise<string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  path?: string;
};

/** The phone-style turn a run sends: the automation's message, exactly, to its chat. */
export function automationMessage(row: StoredAutomation, dueAt: number, now: number): UserMessage {
  const digest = createHash('sha256').update(`${row.id}:${dueAt}:${now}:${randomBytes(8).toString('hex')}`).digest('hex');
  return UserMessage.parse({ type: 'user.message', messageId: AUTOMATION_MESSAGE_PREFIX + digest.slice(0, 40),
    sessionId: row.sessionId, agent: row.agent, text: row.prompt, createdAt: now });
}

/**
 * Runs GrantTap automations from the persistent monitor. Each pass reads the saved automations, takes up
 * the runs that came due and claims those whose chat is free, all in one locked step, and records a claimed
 * run as ran before handing it to the chat: a monitor stopped halfway never sends it twice. A refusal
 * turns it into failed. One pass at a time; deliveries go on while the next pass looks.
 */
export class AutomationRunner {
  private running?: Promise<void>;
  private readonly deliveries = new Set<Promise<void>>();
  private readonly delivering = new Set<string>();
  private failure?: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly path: string;

  constructor(private readonly options: RunnerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (line => { process.stderr.write(`${line}\n`); });
    this.path = options.path ?? automationsPath();
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    const running = this.pass().finally(() => { this.running = undefined; });
    this.running = running;
    return running;
  }

  /** Every delivery this runner started has been taken or refused. */
  async settled(): Promise<void> { while (this.deliveries.size) await Promise.all([...this.deliveries]); }

  private async pass(): Promise<void> {
    const now = this.now();
    let plan: Plan;
    try {
      plan = updateAutomations(state => {
        const planned = planAutomations(state, now, row => this.options.hold(row, now), this.delivering);
        return { changed: planned.changed, value: planned };
      }, this.path);
      this.failure = undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(/[.\s]+$/, '').slice(0, 160) : 'unknown error';
      if (reason !== this.failure) this.log(`[monitor] Automations wait: ${reason}; tried again with the next pass.`);
      this.failure = reason;
      return;
    }
    for (const line of plan.lines) this.log(line);
    for (const run of plan.runs) {
      const delivery = this.run(run, now).finally(() => { this.deliveries.delete(delivery); });
      this.deliveries.add(delivery);
    }
  }

  private async run(run: ClaimedRun, now: number): Promise<void> {
    const { row } = run;
    this.delivering.add(row.sessionId);
    let refusal: string | undefined;
    try { refusal = await this.options.deliver(automationMessage(row, run.dueAt, now), row); }
    catch { refusal = NOT_TAKEN; }
    finally { this.delivering.delete(row.sessionId); }
    const event = run.manual ? 'ran with Run now' : 'ran';
    if (refusal === undefined) return this.log(automationLine(row, event, run.dueAt));
    const reason = refusal.trim().slice(0, 240) || NOT_TAKEN;
    try {
      updateAutomations(state => {
        const saved = state.automations.find(item => item.id === row.id);
        if (!saved?.last || saved.last.at !== now || saved.last.outcome !== 'ran') return { changed: false, value: undefined };
        saved.last = { ...saved.last, outcome: 'failed', reason };
        return { changed: true, value: undefined };
      }, this.path);
    } catch { /* The log still says it failed; the saved state says it ran. */ }
    this.log(automationLine(row, 'failed', run.dueAt, reason));
  }
}
