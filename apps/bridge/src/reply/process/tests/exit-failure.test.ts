import assert from 'node:assert/strict';
import test from 'node:test';
import { isSignInFailure, providerExitFailure, providerSignInFailure } from '../auth-failure';

test('a failed stream-json run reports its reason, not a cut JSON object', () => {
  const result = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true,
    duration_api_ms: 4551710, stop_reason: 'stop_sequence', session_id: '80a46137-280c-4921-9207-5a3534f3c52c',
    total_cost_usd: 100.2, usage: { input_tokens: 0, output_tokens: 0 }, errors: ['Credit balance is too low'] });
  const message = providerExitFailure('/Users/me/.local/bin/claude', '', `{"type":"system"}\n${result}\n`, 1);
  assert.equal(message, 'claude stopped with code 1: Credit balance is too low');
  assert.doesNotMatch(message, /[{}"]/);
});

test('a result without text still names its kind, and plain output stays as it was', () => {
  const result = JSON.stringify({ type: 'result', subtype: 'error_max_turns', stop_reason: 'tool_use' });
  assert.equal(providerExitFailure('claude', '', result, 1), 'claude stopped with code 1: max turns');
  assert.equal(providerExitFailure('claude', 'boom', '', 2), 'claude exited with code 2: boom');
});

test("a request the provider's network protection refused is a network block, not a lapsed login", () => {
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, stop_reason: 'stop_sequence',
    result: 'Failed to authenticate. API Error: 403 Attention Required! | Cloudflare' });
  const blocked = providerExitFailure('/Users/me/.local/bin/claude', '', result, 1);
  assert.match(blocked, /^Claude Code could not reach its service: the request was blocked on the network \(HTTP 403\)\./);
  assert.match(blocked, /not a sign-in problem/);
  assert.match(blocked, /has not been submitted to the agent/);
  assert.equal(isSignInFailure(blocked), false, 'the provider is not marked signed out, and the phone is not sent to sign in');
  assert.equal(providerSignInFailure('claude', 'Failed to authenticate. API Error: 403 <title>Just a moment...</title>'), undefined);
  assert.equal(providerSignInFailure('codex', 'error: 403 Forbidden\nSorry, you have been blocked\ncf-ray: 8c1d'), undefined);
});

test('a real sign-in refusal still asks for sign-in, and says it can be done from the chat', () => {
  const lapsed = providerExitFailure('claude', '', JSON.stringify({ type: 'result', is_error: true,
    result: 'Failed to authenticate: OAuth token has expired. Run `claude auth login`.' }), 1);
  assert.equal(isSignInFailure(lapsed), true);
  assert.match(lapsed, /^Sign-in required for Claude Code\. Tap Sign in in this chat/);
  assert.equal(isSignInFailure(providerExitFailure('claude', 'API Error: 401 authentication_error {"type":"authentication_error"}', '', 1)), true);
  assert.equal(isSignInFailure(providerExitFailure('claude', 'Failed to authenticate. API Error: 403 forbidden', '', 1)), true,
    'a 403 that is not a network block page stays a sign-in problem');
});
