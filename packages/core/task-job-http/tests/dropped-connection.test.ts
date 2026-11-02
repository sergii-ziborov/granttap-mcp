import assert from 'node:assert/strict';
import test from 'node:test';
import { requestTaskJob } from '../index';

const config = { relayUrl: 'wss://relay.example', room: 'room', pushAuth: 'secret' } as never;
const receipt = { job: { id: 'job-12345678', state: 'completed', notBefore: 1, expiresAt: 2 } };
const dropped = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

test('a pooled connection the relay closed is retried once on a fresh one', async () => {
  let calls = 0;
  const request = (async () => {
    calls += 1;
    if (calls === 1) throw dropped();
    return new Response(JSON.stringify(receipt), { status: 200 });
  }) as typeof fetch;
  const result = await requestTaskJob(config, { id: 'job-12345678', method: 'GET' }, request);
  assert.equal(result?.state, 'completed');
  assert.equal(calls, 2);
});

test('other failures and a second drop still surface', async () => {
  let calls = 0;
  const always = (async () => { calls += 1; throw dropped(); }) as typeof fetch;
  await assert.rejects(requestTaskJob(config, { id: 'job-12345678', method: 'GET' }, always), TypeError);
  assert.equal(calls, 2, 'one retry, not a loop');
  calls = 0;
  const refused = (async () => { calls += 1; throw new TypeError('fetch failed'); }) as typeof fetch;
  await assert.rejects(requestTaskJob(config, { id: 'job-12345678', method: 'GET' }, refused), TypeError);
  assert.equal(calls, 1);
});
