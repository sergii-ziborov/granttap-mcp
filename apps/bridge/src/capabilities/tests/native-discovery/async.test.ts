import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { descriptorsForProvider, refreshCodexMcpDescriptors } from '../../descriptors';

test('native MCP discovery yields to request delivery and shares one bounded refresh', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-native-discovery-'));
  const binary = join(root, 'codex'), counter = join(root, 'counter'), data = join(root, 'rows');
  const before = { ...process.env };
  Object.assign(process.env, { GRANTTAP_CODEX_BIN: binary, GRANTTAP_DISCOVERY_COUNTER: counter, GRANTTAP_DISCOVERY_DATA: data });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before); rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(data, JSON.stringify([{ name: 'first', enabled: true }]));
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs');
const p=process.env.GRANTTAP_DISCOVERY_COUNTER;
fs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1));
setTimeout(()=>process.stdout.write(fs.readFileSync(process.env.GRANTTAP_DISCOVERY_DATA)),100);
`, { mode: 0o700 });
  const pending = refreshCodexMcpDescriptors();
  const first = await Promise.race([pending.then(() => 'native completed'),
    new Promise<string>(resolve => setTimeout(() => resolve('event loop responsive'), 10))]);
  assert.equal(first, 'event loop responsive', 'A slow native CLI must not block delivery callbacks');
  await Promise.all([pending, refreshCodexMcpDescriptors()]);
  assert.equal(Number(readFileSync(counter, 'utf8')), 1);
  assert.deepEqual(descriptorsForProvider('codex', root).map(row => row.name), ['first']);
  const next = Date.now() + 31_000;
  t.mock.method(Date, 'now', () => next);
  writeFileSync(data, JSON.stringify([{ name: 'changed', enabled: true }]));
  await refreshCodexMcpDescriptors();
  assert.deepEqual(descriptorsForProvider('codex', root).map(row => row.name), ['changed']);
  assert.equal(Number(readFileSync(counter, 'utf8')), 2);
});
