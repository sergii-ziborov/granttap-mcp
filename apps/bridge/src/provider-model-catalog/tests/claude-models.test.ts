import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EndpointModelCatalog } from "../../../../../packages/protocol/schema";
import { cachedClaudeModels, claudeAliasRows } from "../claude-models";

test("an installed Claude Code advertises its CLI aliases in order, valid on the wire", () => {
  const rows = claudeAliasRows("mac", 100);
  assert.deepEqual(rows.map(row => row.modelId), ["opus", "sonnet", "haiku", "fable"]);
  assert.ok(rows.every(row => row.provider === "claude" && row.source === "advertised" && row.observedAt === 100));
  assert.ok(EndpointModelCatalog.safeParse({ endpointId: "mac", observedAt: 100, models: rows }).success);
});

test("a Mac without Claude Code advertises no Claude models", () => {
  const empty = mkdtempSync(join(tmpdir(), "granttap-no-claude-"));
  const env = { PATH: empty, HOME: empty };
  assert.deepEqual(cachedClaudeModels("mac", env, 10_000_000, empty), []);
  assert.equal(cachedClaudeModels("mac", { ...env, GRANTTAP_CLAUDE_BIN: "/opt/claude" }, 20_000_000, empty).length, 4);
});
