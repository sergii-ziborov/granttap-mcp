import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readInvocationBatch } from "../apps/bridge/src/engine/invocation-log-reader";

test("reader advances only across complete lines and resumes after append", () => {
  const file = join(mkdtempSync(join(tmpdir(), "granttap-inv-reader-")), "session.jsonl");
  writeFileSync(file, "{\"a\":1}\n{\"b\":2}");
  const first = readInvocationBatch(file);
  assert.deepEqual(first.lines.map((row) => row.line), ['{"a":1}']);
  assert.equal(first.gaps.length, 0);
  appendFileSync(file, "\n{\"c\":3}\n");
  const second = readInvocationBatch(file, first.next);
  assert.deepEqual(second.lines.map((row) => row.line), ['{"b":2}', '{"c":3}']);
  assert.equal(second.lines[0]?.offset, 8);
});

test("large or rotated source creates an explicit gap and never parses a partial row", () => {
  const file = join(mkdtempSync(join(tmpdir(), "granttap-inv-gap-")), "session.jsonl");
  writeFileSync(file, "x".repeat(300_000) + "\n{\"ok\":true}\n");
  const first = readInvocationBatch(file);
  assert.deepEqual(first.lines.map((row) => row.line), ['{"ok":true}']);
  assert.equal(first.gaps.length, 1);
  writeFileSync(file, "{\"new\":true}\n");
  const second = readInvocationBatch(file, first.next);
  assert.deepEqual(second.lines.map((row) => row.line), ['{"new":true}']);
  assert.equal(second.gaps.length, 1);
});
