import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixture = `#!/usr/bin/env node
const readline = require("node:readline");
const mode = process.env.FAKE_CODEX_MODE || "success";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (mode === "timeout") return;
  if (mode === "close") { process.stderr.write("fixture failed"); process.exit(7); }
  if (message.method === "initialize") {
    if (mode === "garbage") process.stdout.write("not-json\\n");
    const error = mode === "init-error" ? { message: "initialize rejected" } : undefined;
    process.stdout.write(JSON.stringify({ id: 1, error }) + "\\n");
    return;
  }
  if (message.method === "thread/resume") {
    const error = mode === "resume-error" ? "resume rejected" : undefined;
    process.stdout.write(JSON.stringify({ id: 2, error }) + "\\n");
    return;
  }
  if (message.method === "thread/compact/start") {
    if (mode === "compact-error") {
      process.stdout.write(JSON.stringify({ id: 3, error: {} }) + "\\n");
    } else if (mode === "turn-failed") {
      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "failed" } } }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ id: 3, result: {} }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { type: "contextCompaction" } } }) + "\\n");
    }
  }
});
`;

test("Codex compaction drives the documented app-server protocol and bounds failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-control-"));
  const executable = join(root, "fake-codex");
  await writeFile(executable, fixture);
  await chmod(executable, 0o755);
  process.env.GRANTTAP_CODEX_BIN = executable;
  t.after(() => {
    delete process.env.GRANTTAP_CODEX_BIN;
    delete process.env.FAKE_CODEX_MODE;
  });
  const { compactCodexSession } = await import("../apps/bridge/src/codex-control");

  process.env.FAKE_CODEX_MODE = "success";
  assert.deepEqual(await compactCodexSession("session"), { ok: true });
  for (const [mode, expected] of [
    ["init-error", /initialize rejected/],
    ["resume-error", /resume rejected/],
    ["compact-error", /Unknown Codex app-server error/],
    ["turn-failed", /context compaction failed/],
    ["close", /exited with code 7: fixture failed/],
  ] as const) {
    process.env.FAKE_CODEX_MODE = mode;
    const result = await compactCodexSession("session", 1_000);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, expected);
  }
  process.env.FAKE_CODEX_MODE = "garbage";
  assert.deepEqual(await compactCodexSession("session"), { ok: true });
  process.env.FAKE_CODEX_MODE = "timeout";
  const timedOut = await compactCodexSession("session", 20);
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.match(timedOut.error, /did not finish/);
});
