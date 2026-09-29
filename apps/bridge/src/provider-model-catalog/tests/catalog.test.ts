import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexModelCatalog } from "../index";

const now = Date.parse("2026-09-29T10:00:00Z");
const visible = (slug = "gpt-6-sol") => ({
  slug, display_name: "GPT-6 Sol", description: "Workhorse model for everyday work.",
  visibility: "list", priority: 2, base_instructions: "private instructions",
});

function cache(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "granttap-models-"));
  const path = join(directory, "models_cache.json");
  writeFileSync(path, JSON.stringify(value));
  return { path, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

test("native Codex metadata discovers future visible models and excludes hidden/internal rows", () => {
  const file = cache({ fetched_at: new Date(now).toISOString(), identity: "private account", models: [
    { ...visible("gpt-6-astra"), priority: 1 }, visible(), visible("future-coding-model"),
    { ...visible("codex-auto-review"), visibility: "hide" },
    { ...visible("gpt-reserve"), visibility: "hide" },
    { ...visible("--invalid"), visibility: "list" },
  ] });
  try {
    const report = readCodexModelCatalog("mac-a", { path: file.path, now });
    assert.deepEqual(report.models.map(row => row.modelId), ["gpt-6-astra", "gpt-6-sol", "future-coding-model"]);
    assert.equal(report.models[0]!.endpointId, "mac-a");
    assert.equal(report.models[0]!.source, "advertised");
    assert.equal(report.models[0]!.description, "Workhorse model for everyday work.");
    assert.equal(report.observedAt, now);
    assert.equal(report.stale, false);
    assert.equal(JSON.stringify(report).includes("private"), false);
  } finally { file.remove(); }
});

test("old, future-dated and malformed native catalogs cannot claim current availability", () => {
  for (const fetched_at of [new Date(now - 25 * 60 * 60_000).toISOString(),
    new Date(now + 10 * 60_000).toISOString(), "invalid"]) {
    const file = cache({ fetched_at, models: [visible()] });
    try {
      const report = readCodexModelCatalog("mac", { path: file.path, now });
      assert.equal(report.stale, true);
      assert.equal(report.models.length, 0);
    } finally { file.remove(); }
  }
  const missing = readCodexModelCatalog("mac", { path: "/nonexistent/models_cache.json", now });
  assert.deepEqual(missing.models, []);
  const file = cache({ fetched_at: new Date(now).toISOString(), models: [null, {}, visible()] });
  try {
    assert.equal(readCodexModelCatalog("mac", { path: file.path, now }).models.length, 1);
    writeFileSync(file.path, "not json");
    assert.equal(readCodexModelCatalog("mac", { path: file.path, now }).models.length, 0);
  } finally { file.remove(); }
});

test("a changed provider catalog is reread without restarting the runtime", () => {
  const file = cache({ fetched_at: new Date(now).toISOString(), models: [visible()] });
  try {
    assert.equal(readCodexModelCatalog("mac", { path: file.path, now }).models.length, 1);
    writeFileSync(file.path, JSON.stringify({ fetched_at: new Date(now).toISOString(), models: [visible("gpt-next")] }));
    assert.equal(readCodexModelCatalog("mac", { path: file.path, now }).models[0]!.modelId, "gpt-next");
  } finally { file.remove(); }
});
