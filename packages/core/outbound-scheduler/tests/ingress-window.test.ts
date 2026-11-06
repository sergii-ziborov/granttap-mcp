import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { OutboundFrameQueue } from '..';

test('a negotiated ingress window bounds unacknowledged writes while controls keep priority', async () => {
  const writes: string[] = [];
  const queue = new OutboundFrameQueue(async frame => { writes.push(frame); }, 0);
  queue.enableIngressWindow(16);
  const jobs = Array.from({length: 20}, (_, i) => queue.send(`snapshot-${i}`));
  const pending = Promise.allSettled(jobs);
  await Promise.all(jobs.slice(0, 16));
  assert.equal(writes.length, 16);
  const decision = queue.send('decision', true);
  queue.acknowledgeIngress(8);
  await pending; await decision;
  assert.equal(writes[16], 'decision');
  assert.equal(writes.length, 21);
  queue.cancel();
});

test('invalid, future and replayed ingress receipts cannot grant new credits', async () => {
  const writes: string[] = [];
  const queue = new OutboundFrameQueue(async frame => { writes.push(frame); }, 0);
  queue.enableIngressWindow(16);
  const jobs = Array.from({length: 18}, () => queue.send('synthetic'));
  const pending = Promise.allSettled(jobs);
  await Promise.all(jobs.slice(0, 16));
  for (const invalid of [NaN, -1, 1.5, 17]) queue.acknowledgeIngress(invalid);
  await delay(10); assert.equal(writes.length, 16);
  queue.acknowledgeIngress(1); await jobs[16]; assert.equal(writes.length, 17);
  queue.acknowledgeIngress(1); await delay(10); assert.equal(writes.length, 17);
  queue.acknowledgeIngress(17); await pending; assert.equal(writes.length, 18);
  queue.cancel();
});

test('a disconnected ingress generation rejects all waiting writes', async () => {
  const queue = new OutboundFrameQueue(async () => {}, 0);
  queue.enableIngressWindow(16);
  const jobs = Array.from({length: 20}, () => queue.send('synthetic'));
  const pending = Promise.allSettled(jobs);
  await Promise.all(jobs.slice(0, 16)); queue.cancel();
  const results = await pending;
  assert.equal(results.filter(result => result.status === 'rejected').length, 4);
});
