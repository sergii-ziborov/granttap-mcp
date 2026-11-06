import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { redactSecrets } from "../command-preview";

test("long tool output is redacted without starving relay heartbeats", () => {
  const prefix = "a".repeat(90_000);
  const text = prefix + " https://fixture:synthetic-password@example.test/path";
  const started = performance.now();
  const result = redactSecrets(text);
  const elapsed = performance.now() - started;
  assert.equal(result, prefix + " https://[REDACTED]@example.test/path");
  assert.ok(elapsed < 500, `90 KB of ordinary output blocked the event loop for ${Math.round(elapsed)}ms`);
});
