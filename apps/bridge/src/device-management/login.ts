import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { CodingAgent, ProviderLoginProgress } from '../../../../packages/protocol/schema';
import { signalOwnedProcess } from '../reply/process';
import { stripAnsi } from '../tools/version';
import { allowedLoginURL, installedProvider, loginArguments, providerCommand, providerEnvironment } from './provider-command';

type Flow = { scope: string; child: ChildProcess; progress: ProviderLoginProgress; output: string;
  timer: NodeJS.Timeout; emit: (value: ProviderLoginProgress) => void };
const terminal = new Set(['signed-in', 'failed', 'cancelled', 'expired']);

/** Authentication stays in the provider CLI. Only its temporary browser challenge crosses E2EE. */
export class ProviderLogins {
  private flows = new Map<string, Flow>();
  constructor(private launch = spawn, private command = providerCommand, private now = Date.now) {}

  active(): boolean { return [...this.flows.values()].some(f => !terminal.has(f.progress.phase)); }

  /** A phone can leave for Safari while its final event is dropped. Status refresh replays only its latest flows. */
  replay(scope: string): void {
    const latest = new Map<CodingAgent, Flow>();
    for (const flow of this.flows.values()) if (flow.scope === scope) latest.set(flow.progress.agent, flow);
    for (const flow of latest.values()) flow.emit(flow.progress);
  }

  start(scope: string, agent: CodingAgent, emit: Flow['emit']): ProviderLoginProgress {
    const existing = [...this.flows.values()].find(f => f.scope === scope && f.progress.agent === agent
      && !terminal.has(f.progress.phase));
    if (existing) { existing.emit = emit; return existing.progress; }
    if (this.activeFor(agent)) throw Error('A sign-in for this provider is already open on another controller.');
    const command = this.command(agent);
    if (!installedProvider(command)) throw Error('Install this provider on the computer before signing in.');
    this.prune();
    if (this.flows.size >= 8) throw Error('Too many sign-in requests. Wait for an existing sign-in to expire.');
    const progress: ProviderLoginProgress = { operationId: randomUUID(), agent, phase: 'starting',
      expiresAt: this.now() + 10 * 60_000, message: 'Starting provider sign-in on this computer…' };
    const child = this.launch(command, loginArguments(agent), { env: { ...providerEnvironment(), BROWSER: '/usr/bin/false' },
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const timer = setTimeout(() => this.finish(progress.operationId, 'expired', 'Sign-in expired. Start again.'), 10 * 60_000);
    timer.unref();
    const flow: Flow = { scope, child, progress, output: '', timer, emit };
    this.flows.set(progress.operationId, flow);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', value => this.output(flow, String(value)));
    child.stderr?.on('data', value => this.output(flow, String(value)));
    child.stdin?.on('error', () => this.finish(progress.operationId, 'failed', 'The provider closed sign-in input. Start again.'));
    child.on('error', () => this.finish(progress.operationId, 'failed', 'The provider could not start sign-in.'));
    child.on('close', code => this.finish(progress.operationId, code === 0 ? 'signed-in' : 'failed',
      code === 0 ? 'Signed in on this computer.' : 'The provider did not complete sign-in. Start again.'));
    return progress;
  }

  private activeFor(agent: CodingAgent): boolean {
    return [...this.flows.values()].some(f => f.progress.agent === agent && !terminal.has(f.progress.phase));
  }

  private output(flow: Flow, value: string): void {
    if (terminal.has(flow.progress.phase)) return;
    flow.output = stripAnsi(flow.output + value).slice(-65_536);
    const urls = flow.output.match(/https:\/\/[^\s<>"\u001b]+/g) ?? [];
    const verificationURL = urls.map(url => allowedLoginURL(flow.progress.agent, url.replace(/[).,]+$/, ''))).find(Boolean);
    if (!verificationURL) return;
    const queryCode = new URL(verificationURL).searchParams.get('user_code');
    const userCode = queryCode && /^[A-Z0-9-]{3,128}$/i.test(queryCode) ? queryCode
      : /(?:user|device|verification|one.time|enter(?:\s+the)?)?\s*code\s*[:\n]\s*([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})?)/i.exec(flow.output)?.[1]
      ?? /\bcode\b[^\r\n]{0,100}\r?\n\s*([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){1,3})\b/i.exec(flow.output)?.[1];
    const phase = flow.progress.agent === 'claude' ? 'awaiting-code' : 'awaiting-browser';
    if (flow.progress.verificationURL === verificationURL && flow.progress.userCode === userCode && flow.progress.phase === phase) return;
    flow.progress = { ...flow.progress, phase, verificationURL, userCode,
      message: phase === 'awaiting-code' ? 'Open the provider, then paste its authorization code here.'
        : 'Open the provider and approve sign-in. This computer will finish automatically.' };
    flow.emit(flow.progress);
  }

  code(scope: string, agent: CodingAgent, operationId: string, code: string): ProviderLoginProgress {
    const flow = this.owned(scope, agent, operationId);
    if (flow.progress.phase !== 'awaiting-code') throw Error('This sign-in is not waiting for an authorization code.');
    if (/[\r\n\u0000]/.test(code) || !code.trim() || code.length > 4_096) throw Error('Paste a single authorization code.');
    flow.child.stdin?.write(code.trim() + '\n');
    return flow.progress;
  }

  cancel(scope: string, agent: CodingAgent, operationId: string): ProviderLoginProgress {
    const flow = this.owned(scope, agent, operationId);
    this.finish(operationId, 'cancelled', 'Sign-in cancelled. Existing credentials were not removed.');
    return flow.progress;
  }

  private owned(scope: string, agent: CodingAgent, operationId: string): Flow {
    const flow = this.flows.get(operationId);
    if (!flow || flow.scope !== scope || flow.progress.agent !== agent) throw Error('This sign-in belongs to another controller or has expired.');
    if (this.now() >= flow.progress.expiresAt) this.finish(operationId, 'expired', 'Sign-in expired. Start again.');
    if (terminal.has(flow.progress.phase)) throw Error('This sign-in has ended.');
    return flow;
  }

  private finish(id: string, phase: ProviderLoginProgress['phase'], message: string): void {
    const flow = this.flows.get(id);
    if (!flow || terminal.has(flow.progress.phase)) return;
    clearTimeout(flow.timer);
    if (phase !== 'signed-in') {
      signalOwnedProcess(flow.child, 'SIGTERM');
      const kill = setTimeout(() => {
        if (flow.child.exitCode == null && flow.child.signalCode == null) signalOwnedProcess(flow.child, 'SIGKILL');
      }, 1_000);
      kill.unref();
    }
    flow.output = '';
    flow.progress = { operationId: id, agent: flow.progress.agent, phase, message, expiresAt: flow.progress.expiresAt };
    flow.emit(flow.progress);
  }

  private prune(): void {
    for (const [id, f] of this.flows) {
      if (terminal.has(f.progress.phase) && this.now() >= f.progress.expiresAt) this.flows.delete(id);
    }
  }
}
export const providerLogins = new ProviderLogins();
