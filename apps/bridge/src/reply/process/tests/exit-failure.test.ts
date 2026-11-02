import assert from 'node:assert/strict';
import test from 'node:test';
import { providerExitFailure } from '../auth-failure';

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
