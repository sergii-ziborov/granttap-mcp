import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliModelRows, parseCLIModels } from "../cli-models";
import { readGrokModelDetails } from "../grok-cache";

const now = Date.parse("2026-10-16T12:00:00Z");
const effort = (value: string) => ({ id: value, value, label: value, description: "private text", default: false });
const info = (id: string, extra: Record<string, unknown> = {}) => ({ info: {
  id, model: id, name: id.replace("grok-", "Grok "), description: "Frontier model", base_url: "https://private.example",
  extra_headers: { authorization: "private" }, hidden: false, supports_reasoning_effort: true,
  reasoning_efforts: ["xhigh", "high", "medium", "low"].map(effort), ...extra,
}, api_key: "private-key" });

function grokHome(cache: unknown): { root: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), "granttap-grok-"));
  writeFileSync(join(root, "models_cache.json"), typeof cache === "string" ? cache : JSON.stringify(cache));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

const listing = "You are logged in with grok.com.\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.5\n  - grok-new\n";

test("Grok Build's own catalog names its listed models and the efforts each accepts", () => {
  const home = grokHome({ fetched_at: new Date(now).toISOString(), identity: "private@example.com", models: {
    "grok-4.7": info("grok-4.7"),
    "grok-4.5": info("grok-4.5", { reasoning_efforts: ["high", "medium", "low"].map(effort) }),
    "grok-hidden": info("grok-hidden", { hidden: true }),
  } });
  try {
    const rows = cliModelRows("", listing, home.root, "mac", now);
    assert.deepEqual(rows.map(row => row.modelId), ["grok-4.7", "grok-4.5", "grok-new"], "the CLI list decides what exists");
    assert.deepEqual(rows.map(row => row.priority), [0, 1, 2], "the CLI order survives the phone's sort");
    assert.equal(rows[0]!.label, "Grok 4.7");
    assert.deepEqual(rows[0]!.supportedEfforts, ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(rows[1]!.supportedEfforts, ["low", "medium", "high"]);
    assert.equal(rows[2]!.supportedEfforts, undefined, "a model the cache does not describe stays undescribed");
    assert.equal(rows[2]!.label, "grok-new");
    assert.equal(JSON.stringify(rows).includes("private"), false, "identity, keys, headers and endpoints stay local");
  } finally { home.remove(); }
});

test("a Grok listing that failed to run falls back to the fresh account catalog, a signed-out one to nothing", () => {
  const home = grokHome({ fetched_at: new Date(now - 60_000).toISOString(), models: {
    "grok-4.7": info("grok-4.7"), "grok-hidden": info("grok-hidden", { hidden: true }),
  } });
  try {
    const fallback = cliModelRows("", "", home.root, "mac", now);
    assert.deepEqual(fallback.map(row => row.modelId), ["grok-4.7"]);
    assert.equal(fallback[0]!.observedAt, now - 60_000, "the rows are as old as the provider's fetch");
    assert.deepEqual(cliModelRows("", "Please log in to continue", home.root, "mac", now), []);
  } finally { home.remove(); }
  for (const cache of [
    { fetched_at: new Date(now - 25 * 60 * 60_000).toISOString(), models: { "grok-4.7": info("grok-4.7") } },
    { fetched_at: "invalid", models: {} }, { fetched_at: new Date(now).toISOString(), models: [] }, "not json",
  ]) {
    const stale = grokHome(cache);
    try {
      assert.equal(readGrokModelDetails(stale.root, now), undefined);
      assert.deepEqual(cliModelRows("", "", stale.root, "mac", now), [], "unknown stays unknown");
    } finally { stale.remove(); }
  }
  assert.equal(readGrokModelDetails("/nonexistent-grok-home", now), undefined);
});

test("Cursor rows keep their CLI order and labels", () => {
  const rows = cliModelRows("auto - Auto\ngpt-x-high - GPT X High\n", "", "/nonexistent-grok-home", "mac", now);
  assert.deepEqual(rows.map(row => [row.modelId, row.label, row.priority]), [["auto", "Auto", 0], ["gpt-x-high", "GPT X High", 1]]);
  assert.deepEqual(parseCLIModels("auto - Auto", "cursor", "mac", now)[0]!.priority, 0);
});
