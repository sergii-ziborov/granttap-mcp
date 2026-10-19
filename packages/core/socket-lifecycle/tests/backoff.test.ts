import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayReconnectBackoff } from '../reconnect-backoff';

test('short opens retain exponential pacing and a healthy non-policy connection resets it', () => {
  let now = 100;
  const backoff = new RelayReconnectBackoff(10, 100, () => now, () => .5);
  assert.equal(backoff.delay(), 10);
  backoff.closed(now, 1006, '');
  assert.equal(backoff.delay(), 20);
  backoff.closed(undefined, 1006, '');
  assert.equal(backoff.delay(), 40);
  now = 31_000;
  backoff.closed(100, 1006, '');
  assert.equal(backoff.delay(), 10);
});

test('server policy floors survive the ordinary cap and cannot be shortened by a repeated hint', () => {
  let now = 100;
  const backoff = new RelayReconnectBackoff(10, 100, () => now, () => 1);
  backoff.closed(0, 4425, 'cool-down; retry-after=300');
  assert.equal(backoff.delay(), 300_000);
  now += 1000;
  backoff.defer('1');
  assert.equal(backoff.delay(), 299_000);
  for (const invalid of ['-1', 'Infinity', '100000', '1.5', '1; secret', undefined, ['2']]) backoff.defer(invalid);
  assert.equal(backoff.delay(), 299_000);
  now = 400_000;
  assert.equal(backoff.delay(), 96);
});

test('jitter stays bounded and a bare policy close still paces retries', () => {
  const low = new RelayReconnectBackoff(10, 100, () => 0, () => 0);
  assert.equal(low.delay(), 10);
  assert.equal(low.delay(), 16);
  low.closed(0, 1008, 'policy');
  assert.equal(low.delay(), 100);
  const high = new RelayReconnectBackoff(10, 100, () => 0, () => 1);
  assert.equal(high.delay(), 12);
});
