import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ProviderLogins } from '../login';
import { allowedLoginURL, loginArguments, providerEnvironment } from '../provider-command';

function fixture() {
  const children: any[] = [], events: any[] = [], calls: any[] = [];
  const launch = ((...args: any[]) => {
    calls.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; return true; }; children.push(child); return child;
  }) as any;
  const logins = new ProviderLogins(launch, () => process.execPath);
  return { logins, children, events, calls, emit: (value: any) => events.push(value) };
}

test('device sign-in is scoped, idempotent and never executes a browser URL as a command', () => {
  const f = fixture();
  const flow = f.logins.start('room:phone', 'codex', f.emit);
  const again = f.logins.start('room:phone', 'codex', f.emit);
  assert.equal(flow.operationId, again.operationId); assert.equal(f.children.length, 1);
  assert.deepEqual(f.calls[0][1], ['login', '--device-auth']);
  assert.throws(() => f.logins.start('other-room:phone', 'codex', f.emit), /another controller/);
  const child = f.children[0];
  child.stdout.write('Open https://auth.openai.com/device\nEnter the code: ABCD-1234\n');
  assert.equal(f.events.at(-1).verificationURL, 'https://auth.openai.com/device');
  assert.equal(f.events.at(-1).userCode, 'ABCD-1234');
  assert.equal(f.events.at(-1).phase, 'awaiting-browser');
  assert.throws(() => f.logins.cancel('other-room:phone', 'codex', flow.operationId), /another controller/);
  assert.throws(() => f.logins.code('room:phone', 'claude', flow.operationId, 'code'), /another controller/);
  assert.throws(() => f.logins.code('room:phone', 'codex', flow.operationId, 'code'), /not waiting/);
  child.emit('close', 0);
  assert.equal(f.events.at(-1).phase, 'signed-in');
  assert.equal(f.events.at(-1).verificationURL, undefined);
  assert.equal(f.logins.active(), false);
});

test('manual Claude code only reaches the owned CLI stdin and cannot be replayed after cancellation', () => {
  const f = fixture(), flow = f.logins.start('a:phone', 'claude', f.emit);
  const child = f.children[0]; let input = '';
  child.stdin.on('data', (value: Buffer) => { input += value; });
  child.stderr.write('https://claude.ai/oauth/authorize?state=temporary\n');
  assert.equal(f.events.at(-1).phase, 'awaiting-code');
  assert.throws(() => f.logins.code('a:phone', 'claude', flow.operationId, 'first\nsecond'), /single/);
  f.logins.code('a:phone', 'claude', flow.operationId, 'temporary-code');
  assert.equal(input, 'temporary-code\n');
  assert.equal(JSON.stringify(f.events).includes('temporary-code'), false);
  f.logins.cancel('a:phone', 'claude', flow.operationId);
  assert.equal(child.killed, true); assert.equal(f.events.at(-1).phase, 'cancelled');
  assert.equal(f.events.at(-1).verificationURL, undefined);
  assert.throws(() => f.logins.code('a:phone', 'claude', flow.operationId, 'replay'), /ended/);
  child.emit('close', 0);
  assert.equal(f.events.at(-1).phase, 'cancelled', 'A late successful exit cannot replace cancellation');
});

test('provider errors retain no raw output or secrets and expiry kills only the owned process', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.logins.start('a:p', 'grok', f.emit);
  f.children[0].stderr.write('secret-key https://evil.example/login');
  f.children[0].emit('error', Error('access_token=secret'));
  assert.equal(f.events.at(-1).phase, 'failed'); assert.equal(JSON.stringify(f.events).includes('secret'), false);
  f.logins.start('a:p', 'grok', f.emit);
  t.mock.timers.tick(600_001);
  assert.equal(f.events.at(-1).phase, 'expired'); assert.equal(f.children[1].killed, true);
});

test('native provider URLs must be HTTPS on their own domains and cannot expose tokens', () => {
  assert.equal(loginArguments('grok').includes('--device-auth'), true);
  assert.deepEqual(loginArguments('cursor'), ['login']);
  assert.equal(providerEnvironment().PATH?.split(':')[0], process.execPath.slice(0, process.execPath.lastIndexOf('/')));
  for (const value of ['https://openai.com.evil.example/', 'https://evil-openai.com/',
    'http://auth.openai.com/', 'https://user:pass@openai.com/', 'https://auth.openai.com/?refresh_token=secret',
    'javascript:alert(1)', 'not a url']) assert.equal(allowedLoginURL('codex', value), undefined);
  assert.equal(allowedLoginURL('grok', 'https://accounts.x.ai/device'), 'https://accounts.x.ai/device');
});

test('real Codex multiline and Grok prefilled device challenges preserve their codes', () => {
  const f = fixture();
  const codex = f.logins.start('a:p', 'codex', f.emit);
  f.children[0].stdout.write('https://auth.openai.com/codex/device\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mAB12-CD345\u001b[0m\n');
  assert.equal(f.events.at(-1).userCode, 'AB12-CD345');
  f.logins.cancel('a:p', 'codex', codex.operationId);
  const grok = f.logins.start('a:p', 'grok', f.emit);
  f.children[1].stderr.write('To sign in: https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH\n');
  assert.equal(f.events.at(-1).userCode, 'ABCD-EFGH');
  f.logins.cancel('a:p', 'grok', grok.operationId);
});

test('returning from a browser recovers the final sign-in even when the original event was lost', () => {
  const f = fixture(); let online = false; const received: any[] = [];
  f.logins.start('room:phone', 'codex', value => { if (online) received.push(value); });
  f.children[0].stdout.write('https://auth.openai.com/device\nCode: ABCD-1234\n');
  f.children[0].emit('close', 0);
  assert.equal(received.length, 0);
  online = true;
  f.logins.replay('room:other-phone'); assert.equal(received.length, 0);
  f.logins.replay('room:phone');
  assert.equal(received.at(-1).phase, 'signed-in');
  assert.equal(received.at(-1).verificationURL, undefined);
  assert.equal(received.at(-1).userCode, undefined);
  f.logins.replay('room:phone');
  assert.equal(f.children.length, 1, 'Status refresh must never launch another login');
});

test('reconnect replays only the latest flow for each provider and retains other providers completed state', () => {
  const f = fixture(), codex = f.logins.start('room:phone', 'codex', f.emit);
  f.children[0].emit('close', 0);
  const first = f.logins.start('room:phone', 'grok', f.emit);
  f.logins.cancel('room:phone', 'grok', first.operationId);
  const next = f.logins.start('room:phone', 'grok', f.emit);
  f.events.length = 0; f.logins.replay('room:phone');
  assert.deepEqual(f.events.map(e => e.operationId), [codex.operationId, next.operationId]);
  assert.equal(f.events[0].phase, 'signed-in');
  assert.equal(f.events[1].phase, 'starting');
  f.logins.cancel('room:phone', 'grok', next.operationId);
});
