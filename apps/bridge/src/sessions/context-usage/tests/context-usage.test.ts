import assert from "node:assert/strict";
import test from "node:test";
import { SessionContextUsage } from "../../../../../../packages/protocol/schema";
import { claudeContextReport, codexContextReport } from "..";

const at = Date.parse("2026-11-05T10:00:00Z");

test("Codex context is what its last request sent, split into cached and new input, with the reported window", () => {
  const report = codexContextReport({
    last_token_usage: { input_tokens: 120_000, cached_input_tokens: 90_000, output_tokens: 2_400, reasoning_output_tokens: 900 },
    model_context_window: 258_400,
  }, at);
  assert.deepEqual(report, { observedAt: at, source: "codex", usedTokens: 120_000, windowTokens: 258_400,
    lastOutputTokens: 2_400, parts: [{ id: "cached-input", tokens: 90_000 }, { id: "new-input", tokens: 30_000 }] });
  assert.equal(SessionContextUsage.safeParse(report).success, true);
  assert.equal(codexContextReport({ last_token_usage: { input_tokens: -1 } }, at), undefined);
  assert.equal(codexContextReport({ model_context_window: 258_400 }, at), undefined, "No request, no context reading.");
  assert.deepEqual(codexContextReport({ last_token_usage: { input_tokens: 10, cached_input_tokens: 50 } }, at)?.parts,
    [{ id: "cached-input", tokens: 10 }, { id: "new-input", tokens: 0 }], "Cached input never exceeds what was sent.");
});

test("Claude context is the last turn's prompt: read from cache, written to cache and new input", () => {
  const report = claudeContextReport({ input_tokens: 12, cache_creation_input_tokens: 4_000,
    cache_read_input_tokens: 590_000, output_tokens: 1_500 }, at, { windowTokens: 1_000_000 });
  assert.deepEqual(report, { observedAt: at, source: "claude", usedTokens: 594_012, windowTokens: 1_000_000,
    lastOutputTokens: 1_500, parts: [{ id: "cache-read", tokens: 590_000 },
      { id: "cache-write", tokens: 4_000 }, { id: "new-input", tokens: 12 }] });
  assert.equal(SessionContextUsage.safeParse(report).success, true);
  assert.equal(claudeContextReport({ input_tokens: 5 }, at)?.windowTokens, undefined, "An unknown window stays unknown.");
  assert.equal(claudeContextReport({ output_tokens: 5 }, at), undefined);
  assert.equal(claudeContextReport({ input_tokens: 5 }, 0), undefined, "A reading needs its time.");
  assert.equal(claudeContextReport({ input_tokens: 5, cache_read_input_tokens: "1" }, at), undefined,
    "A row with one malformed counter is rejected whole, as the session totals reject it.");
});
