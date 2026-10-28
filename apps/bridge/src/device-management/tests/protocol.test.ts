import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceManagementRequest, Payload } from '../../../../../packages/protocol/schema';
import { runProcess, providerProcessEnvironment } from '../../reply/process';
import { providerSignInFailure } from '../../reply/process/auth-failure';

test('mutation requests require a concrete computer, provider and a scoped authorization code', () => {
  const base = { type: 'device.manage', requestId: 'qa', createdAt: 1_000 };
  assert.equal(Payload.safeParse({ ...base, action: 'status' }).success, true);
  for (const value of [{ ...base, action: 'runtime-restart' },
    { ...base, computerId: 'mac', action: 'provider-login' },
    { ...base, computerId: 'mac', action: 'provider-update' },
    { ...base, computerId: 'mac', action: 'provider-login-code', agent: 'claude', code: 'secret' },
    { ...base, computerId: 'mac', action: 'clear-cache', code: 'unexpected' },
    { ...base, computerId: 'mac', action: 'clear-cache', path: '/user/project' }]) {
    assert.equal(DeviceManagementRequest.safeParse(value).success, false);
  }
  assert.equal(DeviceManagementRequest.safeParse({ ...base, computerId: 'mac', action: 'provider-login-code',
    agent: 'claude', operationId: 'owned', code: 'once' }).success, true);
  for (const agent of ['claude', 'codex', 'grok', 'cursor']) {
    assert.equal(DeviceManagementRequest.safeParse({ ...base, computerId: 'mac', action: 'provider-update', agent }).success, true);
  }
});

test('a native login failure is returned immediately without pretending the agent accepted the prompt', async () => {
  assert.match(providerSignInFailure('/native/grok', 'Not logged in. Please sign in first.')!, /Sign-in required for Grok/);
  assert.equal(providerSignInFailure('/native/grok', 'hook output: not logged in to test registry'), undefined);
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', "process.stderr.write('Authentication required. Sign in first.\\n');setTimeout(()=>{},10000)"],
    undefined, 5_000, () => ({ ok: true, text: 'incorrect success' }), undefined, undefined,
    { confirmed: () => false, withinMs: 4_000, timeoutMessage: 'incorrect timeout' });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error, /Open Devices/); assert.equal(result.delivery, undefined); }
  assert(Date.now() - started < 2_000);
});

test('a stripped launchd PATH still supplies Node to provider hooks and keeps UTF8 intact across chunks', async () => {
  const previous = process.env.PATH; process.env.PATH = '/usr/bin:/bin';
  try {
    assert.equal(providerProcessEnvironment().PATH?.startsWith(process.execPath.slice(0, process.execPath.lastIndexOf('/'))), true);
    const script = `const {spawnSync}=require('node:child_process');
      if(spawnSync('node',['--version']).status!==0)process.exit(7);
      const b=Buffer.from('Принято ✓');process.stdout.write(b.subarray(0,1));
      setTimeout(()=>process.stdout.write(b.subarray(1)),30);`;
    const result = await runProcess(process.execPath, ['-e', script], undefined, 5_000,
      stdout => ({ ok: true, text: stdout }));
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.text, 'Принято ✓');
  } finally { process.env.PATH = previous; }
});
