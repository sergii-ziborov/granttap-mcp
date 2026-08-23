import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCursorSession,
  createGrokSession,
  deliverToSession,
} from "../apps/bridge/src/reply";

async function executable(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return path;
}

test("Cursor new task and continuation use its persisted headless session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-headless-"));
  const bin = await executable(root, "cursor.mjs", [
    "const args = process.argv.slice(2);",
    "const at = args.indexOf('--resume');",
    "const resumed = at >= 0 ? args[at + 1] : undefined;",
    "process.stdout.write(JSON.stringify({ type: 'result', result: args.join('|'), session_id: resumed || 'cursor-new' }));",
  ].join("\n"));
  const previous = process.env.GRANTTAP_CURSOR_AGENT_BIN;
  process.env.GRANTTAP_CURSOR_AGENT_BIN = bin;
  t.after(() => previous == null
    ? delete process.env.GRANTTAP_CURSOR_AGENT_BIN
    : process.env.GRANTTAP_CURSOR_AGENT_BIN = previous);

  const created = await createCursorSession("Implement", root, 5_000);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.sessionId, "cursor-new");
  assert.match(created.text, /-p\|--output-format\|json\|Implement/);
  const resumed = await deliverToSession({
    sessionId: "cursor-existing", agent: "cursor", cwd: root, state: "idle",
    startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0,
  }, "Continue", 5_000);
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.match(resumed.text, /--resume\|cursor-existing/);
});

test("Grok Build new task fixes an identity and continuation resumes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-headless-"));
  const bin = await executable(root, "grok.mjs", [
    "const args = process.argv.slice(2);",
    "const selectedAt = args.indexOf('--session-id');",
    "const resumeAt = args.indexOf('--resume');",
    "const selected = selectedAt >= 0 ? args[selectedAt + 1] : undefined;",
    "const resumed = resumeAt >= 0 ? args[resumeAt + 1] : undefined;",
    "const id = resumed || selected;",
    "process.stdout.write(JSON.stringify({ type: 'text', data: args.join('|') }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'end', sessionId: id }) + '\\n');",
  ].join("\n"));
  const previous = process.env.GRANTTAP_GROK_BIN;
  process.env.GRANTTAP_GROK_BIN = bin;
  t.after(() => previous == null
    ? delete process.env.GRANTTAP_GROK_BIN
    : process.env.GRANTTAP_GROK_BIN = previous);

  const created = await createGrokSession("Verify", root, 5_000);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.match(created.sessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.match(created.text, /--no-auto-update\|--cwd/);
  assert.match(created.text, /--output-format\|streaming-json/);
  const resumed = await deliverToSession({
    sessionId: "grok-existing", agent: "grok", cwd: root, state: "idle",
    startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0,
  }, "Continue", 5_000);
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.match(resumed.text, /--resume\|grok-existing/);
});
