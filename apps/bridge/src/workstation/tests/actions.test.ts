import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceManagementRequest, DeviceManagementResult } from '../../../../../packages/protocol/schema';
import { handleDeviceManagement } from '../../device-management';

test('workstation-settings carries its settings, and only it does', () => {
  const base = { type: 'device.manage', requestId: 'ws', computerId: 'mac', createdAt: 1 } as const;
  const settings = { automaticScan: 'off', lowSpaceAlert: false } as const;
  assert.equal(DeviceManagementRequest.safeParse({ ...base, action: 'workstation-settings', workstation: settings }).success, true);
  assert.equal(DeviceManagementRequest.safeParse({ ...base, action: 'workstation-settings' }).success, false);
  assert.equal(DeviceManagementRequest.safeParse({ ...base, action: 'workstation-scan', workstation: settings }).success, false);
  assert.equal(DeviceManagementRequest.safeParse({ ...base, action: 'workstation-scan' }).success, true);
  assert.equal(DeviceManagementRequest.safeParse({ ...base, action: 'workstation-settings',
    workstation: { ...settings, deleteEverything: true } }).success, false);
});

test('the phone turns automatic checks off, sees load in the status, and can still measure by hand', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), 'granttap-workstation-actions-'));
  const before = { ...process.env };
  Object.assign(process.env, { GRANTTAP_CONFIG_DIR: directory, GRANTTAP_COMPUTER_ID: 'ws-mac',
    GRANTTAP_CLAUDE_BIN: process.execPath, GRANTTAP_CODEX_BIN: process.execPath,
    GRANTTAP_GROK_BIN: process.execPath, GRANTTAP_CURSOR_AGENT_BIN: process.execPath, GRANTTAP_GROK_DIR: directory });
  delete process.env.GRANTTAP_ENGINE_ENABLED;
  writeFileSync(join(directory, 'machine.json'), JSON.stringify({ room: 'ws-room', role: 'machine', peerPublicKey: 'phone' }));
  const sent: DeviceManagementResult[] = [];
  const client = { room: 'ws-room', sendToPeer: async (value: DeviceManagementResult) => { sent.push(value); } } as any;
  const finished = async (requestId: string) => {
    const until = Date.now() + 20_000;
    while (!sent.some(x => x.requestId === requestId && ['completed', 'failed'].includes(x.phase))) {
      assert(Date.now() < until, 'the action finishes'); await new Promise(resolve => setTimeout(resolve, 10));
    }
    return sent.filter(x => x.requestId === requestId).at(-1)!;
  };
  try {
    await handleDeviceManagement(client, { type: 'device.manage', requestId: 'off', computerId: 'ws-mac',
      action: 'workstation-settings', workstation: { automaticScan: 'off', lowSpaceAlert: true }, createdAt: Date.now() }, 'phone');
    const off = await finished('off');
    assert.equal(off.phase, 'completed');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'workstation', 'settings.json'), 'utf8')),
      { automaticScan: 'off', lowSpaceAlert: true });
    const workstation = off.snapshot?.workstation;
    assert.equal(workstation?.settings.automaticScan, 'off');
    assert.equal(workstation?.load.source, 'basic', 'without the Engine the operating system answers');
    assert.ok((workstation?.load.diskTotalBytes ?? 0) > 0);
    assert.equal(workstation?.fullScanSupported, false);
    assert.equal(DeviceManagementResult.safeParse(off).success, true);

    await handleDeviceManagement(client, { type: 'device.manage', requestId: 'measure', computerId: 'ws-mac',
      action: 'workstation-scan', createdAt: Date.now() }, 'phone');
    const measured = await finished('measure');
    assert.equal(measured.phase, 'completed');
    assert.ok(sent.some(x => x.requestId === 'measure' && x.message === 'Measuring where the space went…'));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});
