import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceManagementRequest } from '../../../../../packages/protocol/schema';
import { handleDeviceManagement } from '../index';

test('only the paired controller on the concrete computer route can manage it; replies stay private', async () => {
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
    assert.equal(sent.at(-1).value.snapshot.runtimeVersion, '0.8.110');
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
