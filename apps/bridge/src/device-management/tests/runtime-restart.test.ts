import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { prepareRuntimeRestart, stopOwnedChildren, type RuntimeRestartHost } from '../runtime-restart';

function host(overrides: Partial<RuntimeRestartHost> = {}) {
  const stopped: ChildProcess[][] = [];
  const value: RuntimeRestartHost = {
    supported: () => true, signingIn: () => false, pendingDecisions: () => 0, activeRuns: () => [],
    stop: async children => { stopped.push(children); }, ...overrides,
  };
  return { value, stopped };
}

const run = { pid: 4242 } as ChildProcess;

test('a hung GrantTap run no longer blocks a confirmed MCP restart from the phone', async () => {
  const busy = host({ activeRuns: () => [run, run], pendingDecisions: () => 1 });
  await assert.rejects(prepareRuntimeRestart(busy.value, false),
    /2 GrantTap requests and 1 decision are still open.*Confirm interruption/);
  assert.equal(busy.stopped.length, 0, 'An unconfirmed restart leaves the runs alone');
  await prepareRuntimeRestart(busy.value, true);
  assert.deepEqual(busy.stopped, [[run, run]], 'A confirmed restart stops them before launchd restarts MCP');
});

test('a restart still waits for sign-in and needs the managed services', async () => {
  await assert.rejects(prepareRuntimeRestart(host({ signingIn: () => true }).value, true), /Finish sign-in/);
  await assert.rejects(prepareRuntimeRestart(host({ supported: () => false }).value, true), /not installed/);
  await prepareRuntimeRestart(host().value, false);
});

test('stopping owned runs ends the provider process group even when it ignores SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { detached: true, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 200));
  const exited = once(child, 'exit');
  await stopOwnedChildren([child], 300);
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
});
