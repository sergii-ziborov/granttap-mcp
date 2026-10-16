import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClaudeSession, createCodexSession, createGrokSession, deliverToSession } from "..";
import { providerEffortArgs } from "../process/provider-effort";
import { resolveGrokBinary } from "../../providers/grok-bin";

async function fake(root: string, name: string, lines: string[]): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\n${lines.join("\n")}\n`, { mode: 0o755 });
  return path;
}

function useBinary(t: test.TestContext, name: string, path: string): void {
  const previous = process.env[name];
  process.env[name] = path;
  t.after(() => previous == null ? delete process.env[name] : process.env[name] = previous);
}

const session = (agent: "claude" | "codex" | "grok", cwd: string) => ({
  sessionId: `${agent}-existing`, agent, cwd, state: "idle" as const,
  startedAt: 1, lastActivityAt: 1, tokensSession: 0, tokensLastTurn: 0,
});

test("each provider receives only the reasoning levels its CLI accepts, as its own flag", () => {
  assert.deepEqual(providerEffortArgs("grok", "xhigh"), ["--reasoning-effort", "xhigh"]);
  assert.deepEqual(providerEffortArgs("grok", "max"), [], "Grok Build has no max level");
  assert.deepEqual(providerEffortArgs("claude", "max"), ["--effort", "max"]);
  assert.deepEqual(providerEffortArgs("claude", "ultra"), []);
  assert.deepEqual(providerEffortArgs("codex", "ultra"), ["-c", 'model_reasoning_effort="ultra"']);
  assert.deepEqual(providerEffortArgs("cursor", "high"), [], "Cursor names effort in its model variants");
  assert.deepEqual(providerEffortArgs("codex", 'high" injected'), []);
});

test("a chosen Claude model and effort reach the CLI on create and on resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claude-args-"));
  useBinary(t, "GRANTTAP_CLAUDE_BIN", await fake(root, "claude.mjs", [
    "process.stdout.write(JSON.stringify({ result: args.join('|'), session_id: 'claude-new' }));",
  ]));
  const created = await createClaudeSession("Start", root, 5_000, [], "opus", undefined, "xhigh");
  assert.equal(created.ok, true);
  if (created.ok) assert.match(created.text, /^-p\|--model\|opus\|--effort\|xhigh\|--output-format\|json\|Start$/);
  const resumed = await deliverToSession(session("claude", root), "Go on", 5_000, [], { model: "sonnet", effort: "low" });
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.match(resumed.text, /--resume\|claude-existing\|--model\|sonnet\|--effort\|low/);
});

test("a chosen Codex model and effort reach the CLI on create and on resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-args-"));
  useBinary(t, "GRANTTAP_CODEX_BIN", await fake(root, "codex.mjs", [
    "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-new' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: args.join('|') } }) + '\\n');",
  ]));
  const created = await createCodexSession("Start", root, 5_000, [], "gpt-6-sol", undefined, "xhigh");
  assert.equal(created.ok, true);
  if (created.ok) assert.match(created.text, /^exec\|-m\|gpt-6-sol\|-c\|model_reasoning_effort="xhigh"\|--json/);
  const resumed = await deliverToSession(session("codex", root), "Go on", 5_000, [], { model: "gpt-6-luna", effort: "low" });
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.match(resumed.text, /exec\|resume\|-m\|gpt-6-luna\|-c\|model_reasoning_effort="low"/);
});

test("a chosen Grok model and its extra-high effort reach the CLI on create and on resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-grok-args-"));
  useBinary(t, "GRANTTAP_GROK_BIN", await fake(root, "grok.mjs", [
    "process.stdout.write(JSON.stringify({ type: 'text', data: args.join('|') }) + '\\n');",
  ]));
  const created = await createGrokSession("Start", root, 5_000, [], "grok-4.7", undefined, "xhigh");
  assert.equal(created.ok, true);
  if (created.ok) assert.match(created.text, /--model\|grok-4\.7\|--reasoning-effort\|xhigh/);
  const resumed = await deliverToSession(session("grok", root), "Go on", 5_000, [], { model: "grok-4.5", effort: "xhigh" });
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.match(resumed.text, /--model\|grok-4\.5\|--reasoning-effort\|xhigh\|--resume\|grok-existing/);
});

test("Grok Build is found where its installer puts it when launchd's PATH lacks it", async () => {
  const home = await mkdtemp(join(tmpdir(), "granttap-grok-home-"));
  assert.equal(resolveGrokBinary({ PATH: "" }, home), "grok", "nothing installed: the bare name, never a guess");
  await mkdir(join(home, ".grok", "bin"), { recursive: true });
  const installed = await fake(join(home, ".grok", "bin"), "grok", []);
  assert.equal(resolveGrokBinary({ PATH: "" }, home), installed);
  assert.equal(resolveGrokBinary({ PATH: "", GRANTTAP_GROK_BIN: "/custom/grok" }, home), "/custom/grok");
  const onPath = await mkdtemp(join(tmpdir(), "granttap-grok-path-"));
  const first = await fake(onPath, "grok", []);
  assert.equal(resolveGrokBinary({ PATH: onPath }, home), first);
});
