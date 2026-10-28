import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceManagementRequest } from '../../../../../packages/protocol/schema';
import { handleDeviceManagement } from '../index';

test('only the paired controller on the concrete computer route can manage it; replies stay private', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), 'granttap-device-handler-'));
  const before = { ...process.env };
  Object.assign(process.env, { GRANTTAP_CONFIG_DIR: directory, GRANTTAP_COMPUTER_ID: 'qa-mac',
    GRANTTAP_CLAUDE_BIN: process.execPath, GRANTTAP_CODEX_BIN: process.execPath,
    GRANTTAP_GROK_BIN: process.execPath, GRANTTAP_CURSOR_AGENT_BIN: process.execPath, GRANTTAP_GROK_DIR: directory });
  writeFileSync(join(directory, 'machine.json'), JSON.stringify({ room: 'paired-room', role: 'machine', peerPublicKey: 'phone' }));
  const sent: any[] = [];
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  const client = { room: 'paired-room', sendToPeer: async (value: any, peer: string, options: any) => {
    sent.push({ value, peer, options }); if (value.phase === 'completed') completed();
  } } as any;
  const request: DeviceManagementRequest = { type: 'device.manage', requestId: 'private-status', action: 'status', createdAt: Date.now() };
  try {
    assert.equal(await handleDeviceManagement(client, request, undefined), false);
    assert.equal(await handleDeviceManagement(client, request, 'foreign-phone'), false);
    assert.equal(await handleDeviceManagement({ ...client, room: 'other-room' }, request, 'phone'), false);
    assert.equal(await handleDeviceManagement(client, { ...request, computerId: 'other-mac' }, 'phone'), false);
    assert.equal(await handleDeviceManagement(client, { ...request, createdAt: Date.now() - 300_000 }, 'phone'), false);
    assert.equal(sent.length, 0);
    assert.equal(await handleDeviceManagement(client, request, 'phone'), true);
    await done;
    assert.equal(sent.at(-1).value.snapshot.computerId, 'qa-mac');
    assert.equal(sent.at(-1).value.snapshot.runtimeVersion, '0.8.111');
    assert.equal(sent.every(x => x.peer === 'phone' && x.options.reliable === false && x.options.urgent === true && x.options.ttlMs === 60_000), true);
    const count = sent.length;
    assert.equal(await handleDeviceManagement(client, request, 'phone'), true);
    assert.equal(sent.length, count + 1, 'A retry returns the saved result rather than repeating the command');
    assert.equal(await handleDeviceManagement(client, { ...request, action: 'runtime-restart', computerId: 'qa-mac' }, 'phone'), false);
    assert.equal(sent.length, count + 1, 'A reused id cannot execute a different mutation');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});

test('a disconnected phone recovers the original provider update result privately without executing it again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'granttap-update-recovery-'));
  const before = { ...process.env };
  const command = join(directory, 'grok'), counter = join(directory, 'updates');
  writeFileSync(counter, '0');
  writeFileSync(command, `#!${process.execPath}\nconst fs=require('node:fs');const p=${JSON.stringify(counter)};
    if(process.argv[2]==='update')fs.writeFileSync(p,String(Number(fs.readFileSync(p))+1));
    if(process.argv[2]==='--version')console.log('grok 1.0.'+fs.readFileSync(p,'utf8'));\n`);
  chmodSync(command, 0o755);
  Object.assign(process.env, { GRANTTAP_CONFIG_DIR: directory, GRANTTAP_COMPUTER_ID: 'update-mac',
    GRANTTAP_CLAUDE_BIN: process.execPath, GRANTTAP_CODEX_BIN: process.execPath,
    GRANTTAP_GROK_BIN: command, GRANTTAP_CURSOR_AGENT_BIN: process.execPath, GRANTTAP_GROK_DIR: directory });
  writeFileSync(join(directory, 'machine.json'), JSON.stringify({ room: 'update-room', role: 'machine',
    peerPublicKey: 'owner', extraPeerPublicKeys: ['other-controller'] }));
  const sent: any[] = [];
  const client = { room: 'update-room', sendToPeer: async (value: any, peer: string) => { sent.push({ value, peer }); } } as any;
  const request: DeviceManagementRequest = { type: 'device.manage', requestId: 'owned-update', computerId: 'update-mac',
    action: 'provider-update', agent: 'grok', createdAt: Date.now() };
  const wait = async (id: string) => {
    const until = Date.now() + 15_000;
    while (!sent.some(x => x.value.requestId === id && ['completed', 'failed'].includes(x.value.phase))) {
      assert(Date.now() < until, 'operation must finish'); await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await handleDeviceManagement(client, request, 'owner'); await wait(request.requestId);
    assert.equal(sent.at(-1).value.phase, 'completed');
    assert.equal(sent.at(-1).value.snapshot.providers.find((p: any) => p.agent === 'grok').version, '1.0.1');
    await handleDeviceManagement(client, request, 'owner');
    sent.length = 0;
    const status: DeviceManagementRequest = { ...request, requestId: 'recover-status', action: 'status', agent: undefined, operationId: request.requestId };
    await handleDeviceManagement(client, status, 'owner'); await wait(status.requestId);
    assert(sent.some(x => x.value.requestId === request.requestId && x.value.phase === 'completed'));
    assert.equal(readFileSync(counter, 'utf8'), '1', 'status and repeated taps cannot rerun an update');
    sent.length = 0;
    await handleDeviceManagement(client, { ...status, requestId: 'other-status' }, 'other-controller'); await wait('other-status');
    assert(!sent.some(x => x.value.requestId === request.requestId), 'another paired controller cannot read the private result');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before); rmSync(directory, { recursive: true, force: true });
  }
});
