import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  displayPath,
  measureAgentDisk,
  parseDuOutput,
  summarize,
} from "../../apps/bridge/src/machine-load/host/disk-usage";

test("du output is read as bytes by path and shown the way a person would type it", () => {
  const sizes = parseDuOutput("  1024\t/Users/me/.claude/projects\n8\t/Users/me/.claude/settings.json\nnonsense\n");
  assert.equal(sizes.get("/Users/me/.claude/projects"), 1024 * 1024);
  assert.equal(sizes.get("/Users/me/.claude/settings.json"), 8 * 1024);
  assert.equal(displayPath("/Users/me/.claude/projects", "/Users/me"), "~/.claude/projects");
  assert.equal(displayPath("/Users/me", "/Users/me"), "~");
  assert.equal(displayPath("/opt/x", "/Users/me"), "/opt/x");
});

test("the heaviest places are listed and the long tail folded into one line", () => {
  const sizes = new Map(Array.from({ length: 11 }, (_, i) => [`/h/.claude/d${i}`, (i + 1) * 1000]));
  const usage = summarize(sizes, "/h", 5);
  assert.equal(usage.measuredAt, 5);
  assert.equal(usage.totalBytes, 66_000);
  assert.equal(usage.entries.length, 9);
  assert.equal(usage.entries[0]?.path, "~/.claude/d10");
  assert.equal(usage.entries[8]?.path, "…");
  assert.equal(usage.entries[8]?.bytes, 1000 + 2000 + 3000);
  assert.equal(summarize(new Map(), "/h", 1).entries.length, 0);
});

test("an agent's folders are measured child by child, and a missing agent measures nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "granttap-disk-"));
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const asked: string[][] = [];
  const du = async (paths: string[]) => {
    asked.push(paths);
    return paths.map((path, index) => `${(index + 1) * 4}\t${path}`).join("\n");
  };
  const claude = await measureAgentDisk("claude", { home, du, now: () => 9 });
  assert.equal(claude?.measuredAt, 9);
  assert.deepEqual(
    [...(asked[0] ?? [])].sort(),
    [join(home, ".claude", "projects"), join(home, ".claude", "settings.json")].sort(),
  );
  assert.equal(claude?.entries.every((entry) => entry.path.startsWith("~/.claude/")), true);
  // An empty folder is measured as itself.
  const codex = await measureAgentDisk("codex", { home, du });
  assert.deepEqual(asked[1], [join(home, ".codex")]);
  assert.equal(codex?.entries[0]?.path, "~/.codex");
  assert.equal(await measureAgentDisk("grok", { home, du }), undefined, "no folder, no measurement");
  assert.equal(await measureAgentDisk("nobody", { home, du }), undefined);
  const failing = async () => { throw new Error("du exploded"); };
  assert.equal(await measureAgentDisk("claude", { home, du: failing }), undefined);
});
