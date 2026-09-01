import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../packages/protocol/schema";
import { UserMessage } from "../packages/protocol/schema";

/** A stub that reports the argv it was launched with, as the reply text. */
async function argvReportingClaude(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "granttap-turn-overrides-"));
  const stub = join(dir, "claude-stub");
  await writeFile(stub, [
    "#!/usr/bin/env node",
    "const argv = process.argv.slice(2).join(' ');",
    "process.stdout.write(JSON.stringify({ result: argv, session_id: 'chat' }));",
  ].join("\n"), { mode: 0o755 });
  const previous = process.env.GRANTTAP_CLAUDE_BIN;
  process.env.GRANTTAP_CLAUDE_BIN = stub;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CLAUDE_BIN;
    else process.env.GRANTTAP_CLAUDE_BIN = previous;
  });
  return dir;
}

function claudeSession(cwd: string): SessionInfo {
  return {
    sessionId: "chat", agent: "claude", cwd, title: "Turn overrides",
    state: "idle", startedAt: 1, lastActivityAt: 1,
  } as SessionInfo;
}

test("the wire keeps the permission mode and effort a turn was sent with", () => {
  // Zod strips unknown keys, so a field the phone sends and the schema omits is
  // discarded in silence -- which is exactly what happened to permissionMode.
  const parsed = UserMessage.parse({
    type: "user.message", text: "go", sessionId: "chat", createdAt: 1,
    model: "opus", permissionMode: "plan", effort: "high",
  });
  assert.equal(parsed.permissionMode, "plan");
  assert.equal(parsed.effort, "high");
});

test("a turn carries its permission mode and effort to the Claude CLI", async (t) => {
  const dir = await argvReportingClaude(t);
  const { deliverToSession } = await import(
    `../apps/bridge/src/reply.ts?turnOverrides=${process.pid}`
  );
  const result = await deliverToSession(claudeSession(dir), "go", 5_000, [], {
    model: "opus", permissionMode: "plan", effort: "high",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /--model opus/);
  assert.match(result.text, /--permission-mode plan/);
  assert.match(result.text, /--effort high/);
});

test("a turn that chose nothing reaches the CLI exactly as it always did", async (t) => {
  const dir = await argvReportingClaude(t);
  const { deliverToSession } = await import(
    `../apps/bridge/src/reply.ts?turnOverridesBare=${process.pid}`
  );
  const result = await deliverToSession(claudeSession(dir), "go", 5_000, [], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.doesNotMatch(result.text, /--permission-mode/);
  assert.doesNotMatch(result.text, /--effort/);
});

test("an effort level the CLI does not accept is refused rather than passed on", () => {
  assert.throws(() => UserMessage.parse({
    type: "user.message", text: "go", createdAt: 1, effort: "maximum",
  }));
  assert.throws(() => UserMessage.parse({
    type: "user.message", text: "go", createdAt: 1, permissionMode: "default",
  }));
});
