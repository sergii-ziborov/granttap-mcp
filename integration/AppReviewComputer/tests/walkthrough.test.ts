import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RelayClient } from '../../../packages/core/relay-client';
import { createPairing, machineConfigPath, saveConfig } from '../../../apps/bridge/src/config';
import { forwardingRelay } from '../../../tests/support/forwarding-relay';
import { runReviewStep } from '../walkthrough';

test('review walkthrough exchanges real encrypted MCP questions and persists only progress', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-review-walkthrough-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const relay = await forwardingRelay();
  const { machineCfg, phoneCfg } = createPairing(relay.url);
  saveConfig(machineConfigPath(), machineCfg);
  const machine = new RelayClient(machineCfg), phone = new RelayClient(phoneCfg);
  t.after(async () => {
    machine.close(); phone.close(); await relay.close();
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  let permissions = 0, questions = 0;
  phone.onMessage(async payload => {
    if (payload.type === 'approval.request') {
      permissions++;
      assert.match(payload.title, /DEMO/);
      await phone.send({ type: 'approval.decision', requestId: payload.requestId,
        decision: 'allow', decidedBy: 'phone', decidedAt: Date.now() }, 'machine', { reliable: false });
    }
    if (payload.type === 'agent.event' && payload.kind === 'question') {
      questions++;
      await phone.send({ type: 'user.message', requestId: payload.requestId,
        text: 'Synthetic private answer must never enter progress state', createdAt: Date.now() },
      'machine', { reliable: false });
    }
    return true;
  });
  await Promise.all([machine.connect(), phone.connect()]);
  assert.equal(await runReviewStep(machine, root, 1_500), true);
  assert.equal(permissions, 1, 'a real question must reach the phone');
  assert.equal(await runReviewStep(machine, root, 1_500), true);
  assert.equal(questions, 1);
  assert.equal(await runReviewStep(machine, root, 1_500), false, 'completed walkthrough waits for its next cycle');
  const saved = readFileSync(join(root, 'review-progress.json'), 'utf8');
  assert.equal(JSON.parse(saved).phase, 2);
  assert.equal(saved.includes('Synthetic'), false);
  assert.equal(saved.includes('private'), false);
});

test('an unanswered step never advances durable progress', async t => {
  const root = mkdtempSync(join(tmpdir(), 'granttap-review-timeout-'));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const relay = await forwardingRelay();
  const { machineCfg } = createPairing(relay.url);
  saveConfig(machineConfigPath(), machineCfg);
  const machine = new RelayClient(machineCfg);
  t.after(async () => {
    machine.close(); await relay.close();
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  await machine.connect();
  assert.equal(await runReviewStep(machine, root, 40), false);
  assert.equal(await runReviewStep(machine, root, 40), false);
});
