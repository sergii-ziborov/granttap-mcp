import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGrantTapServer } from '../../http/create-server';
import { connectInMemory } from '../../../../../tests/support/mcp-client';
import { createPairing, saveConfig, machineConfigPath } from '../../../../bridge/src/config';

function updateSettings(result: unknown) {
  return (result as { structuredContent: { runtimeUpdates: { enabled: boolean; lockedByEnvironment: boolean } } }).structuredContent.runtimeUpdates;
}

test('the plugin saves off/on across MCP restarts without changing pairing or policy', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-update-card-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous; });
  saveConfig(machineConfigPath(), createPairing('ws://127.0.0.1:1').machineCfg);
  const machine = readFileSync(machineConfigPath(), 'utf8');
  const policy = join(root, 'capability-policy.json'); writeFileSync(policy, '{"fixture":"unchanged"}');
  const originalFiles = readdirSync(root);
  const settings = join(root, 'runtime-updates', 'preferences.json');
  for (const enabled of [false, true]) {
    const server = createGrantTapServer(); const client = await connectInMemory(server);
    try {
      const before = await client.callTool({ name: 'connection_status', arguments: {} });
      assert.equal(updateSettings(before).enabled, !enabled);
      if (!enabled) assert.deepEqual(readdirSync(root), originalFiles);
      const result = await client.callTool({ name: 'set_runtime_auto_update', arguments: { enabled } });
      assert.notEqual(result.isError, true);
      assert.equal(updateSettings(result).enabled, enabled);
      assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { automaticUpdatesEnabled: enabled });
      assert.equal(statSync(settings).mode & 0o777, 0o600);
      assert.equal(readFileSync(machineConfigPath(), 'utf8'), machine);
      assert.equal(readFileSync(policy, 'utf8'), '{"fixture":"unchanged"}');
      const invalid = await client.callTool({ name: 'set_runtime_auto_update', arguments: { enabled: 'false' } });
      assert.equal(invalid.isError, true);
    } finally { await client.close(); await server.close(); }
    if (!enabled) {
      const restarted = createGrantTapServer(); const next = await connectInMemory(restarted);
      try {
        const result = await next.callTool({ name: 'connection_status', arguments: {} });
        assert.equal(updateSettings(result).enabled, false);
      } finally { await next.close(); await restarted.close(); }
    }
  }
});

test('service disable cannot be overridden from the plugin, and unreadable preferences stay off', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-update-locked-card-'));
  const keys = ['GRANTTAP_CONFIG_DIR', 'GRANTTAP_DISABLE_AUTO_UPDATE'];
  const previous = keys.map(key => process.env[key]);
  process.env.GRANTTAP_CONFIG_DIR = root; process.env.GRANTTAP_DISABLE_AUTO_UPDATE = '1';
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  const server = createGrantTapServer(); const client = await connectInMemory(server);
  try {
    const result = await client.callTool({ name: 'set_runtime_auto_update', arguments: { enabled: true } });
    assert.equal(result.isError, true);
    const status = await client.callTool({ name: 'connection_status', arguments: {} });
    assert.deepEqual(updateSettings(status), { enabled: false, lockedByEnvironment: true });
    delete process.env.GRANTTAP_DISABLE_AUTO_UPDATE;
    mkdirSync(join(root, 'runtime-updates')); writeFileSync(join(root, 'runtime-updates/preferences.json'), 'invalid');
    const malformed = await client.callTool({ name: 'connection_status', arguments: {} });
    assert.deepEqual(updateSettings(malformed), { enabled: false, lockedByEnvironment: false });
  } finally { await client.close(); await server.close(); }
});
