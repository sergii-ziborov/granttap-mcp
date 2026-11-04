import type { ChildProcess } from 'node:child_process';
import { signalOwnedProcess } from '../reply/process';

/** What a phone-requested MCP restart has to know about this computer before launchd restarts it. */
export type RuntimeRestartHost = {
  supported(): boolean;
  signingIn(): boolean;
  pendingDecisions(): number;
  activeRuns(): ChildProcess[];
  stop(children: ChildProcess[]): Promise<void>;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A restart is most needed when a run has hung, so open work no longer refuses it outright. The phone confirms
 * the interruption; GrantTap's own detached provider runs are stopped first, otherwise they would outlive the
 * monitor that owns their chats.
 */
export async function prepareRuntimeRestart(host: RuntimeRestartHost, interrupt: boolean): Promise<void> {
  if (!host.supported()) throw Error('Managed MCP services are not installed on this computer.');
  if (host.signingIn()) throw Error('Finish sign-in before restarting MCP.');
  const runs = host.activeRuns(), decisions = host.pendingDecisions();
  if ((runs.length || decisions) && !interrupt) {
    const open = [runs.length && plural(runs.length, 'GrantTap request', 'GrantTap requests'),
      decisions && plural(decisions, 'decision', 'decisions')].filter(Boolean).join(' and ');
    throw Error(`${open} ${runs.length + decisions === 1 ? 'is' : 'are'} still open on this computer. `
      + 'Confirm interruption to stop them and restart MCP.');
  }
  if (runs.length) await host.stop(runs);
}

/** SIGTERM the run's process group, then SIGKILL whatever is still there once the grace period ends. */
export async function stopOwnedChildren(children: ChildProcess[], graceMs = 2_000): Promise<void> {
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode != null || child.signalCode != null) { resolve(); return; }
    const timer = setTimeout(() => { signalOwnedProcess(child, 'SIGKILL'); resolve(); }, graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    (child as typeof child & { granttapStopped?: boolean }).granttapStopped = true;
    signalOwnedProcess(child, 'SIGTERM');
  })));
}
