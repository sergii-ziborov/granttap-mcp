import assert from 'node:assert/strict';
import test from 'node:test';
import {NativeTurnCompletions, nativePromptDigest, type NativeCompletionProof} from '../../native-completion';

const proof = (change: Partial<NativeCompletionProof> = {}): NativeCompletionProof => ({
  nativeSessionId: 'native', promptAt: 101, completedAt: 120,
  promptDigests: [nativePromptDigest('Exact routed prompt')], text: 'Native final answer', ...change,
});

test('a confirmed native final releases this prompt while its physical CLI is still waiting', async () => {
  const turns = new NativeTurnCompletions(() => 100), first = turns.begin('alias');
  turns.bind('native', 'Exact routed prompt', key => key === 'alias' ? 'native' : key);
  assert.equal(turns.complete('alias', proof()), true);
  assert.deepEqual(await first.result, {ok: true, text: 'Native final answer', delivery: 'native'});
  assert.equal(turns.complete('alias', proof()), false, 'one terminal native result per invocation');
  first.close(); assert.equal(turns.complete('alias', proof()), false);
});

test('a different prompt, session, old final or future timestamp never releases a pending turn', () => {
  const turns = new NativeTurnCompletions(() => 100), current = turns.begin('chat');
  assert.equal(turns.complete('chat', proof()), false, 'binding to a native invocation is required');
  turns.bind('native', 'Exact routed prompt', key => key === 'chat' ? 'native' : key);
  for (const bad of [proof({nativeSessionId:'other'}),proof({promptDigests:[nativePromptDigest('Other prompt')]}),
    proof({promptAt:99}),proof({completedAt:100}),proof({completedAt:6000}),proof({text:' '})]) {
    assert.equal(turns.complete('chat', bad), false);
  }
  assert.equal(turns.complete('unknown', proof()), false); current.close();
});

test('closing an older completion cannot remove the next turn, including a repeated identical prompt', async () => {
  let now = 100; const turns = new NativeTurnCompletions(() => now);
  const old = turns.begin('chat'); turns.bind('native','Exact routed prompt',()=> 'native');
  now = 200; const next = turns.begin('chat'); turns.bind('native','Exact routed prompt',()=> 'native');
  old.close(); assert.equal(turns.complete('chat',proof()),false,'the same text from the preceding turn is not receipt');
  assert.equal(turns.complete('chat',proof({promptAt:201,completedAt:220})),true);
  assert.equal((await next.result).ok,true); next.close();
});
