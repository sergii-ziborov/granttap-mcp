import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../packages/protocol/schema";
import { runProcess } from "../apps/bridge/src/reply/process";

async function script(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return path;
}

function session(agent: SessionInfo["agent"], id: string, cwd: string): SessionInfo {
  return {
    sessionId: id, agent, cwd, state: "idle", startedAt: 1, lastActivityAt: 1,
    tokensSession: 0, tokensLastTurn: 0,
  };
}

test("Claude delivery preserves JSON errors and bounded plain or empty fallbacks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claude-reply-edges-"));
  const binary = await script(root, "claude.mjs", [
    "const prompt = process.argv.at(-1);",
    "if (prompt.includes('json-error')) process.stdout.write(JSON.stringify({is_error:true,result:'blocked'}));",
    "else if (prompt.includes('json-default-error')) process.stdout.write(JSON.stringify({is_error:true}));",
    "else if (prompt.includes('json-ok')) process.stdout.write(JSON.stringify({result:'ok',session_id:'created'}));",
    "else if (prompt.includes('plain')) process.stdout.write('plain response');",
    "else if (prompt.includes('invalid')) process.stdout.write('{bad json');",
  ].join("\n"));
  const previousBin = process.env.GRANTTAP_CLAUDE_BIN;
  const previousConfig = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CLAUDE_BIN = binary;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previousBin == null) delete process.env.GRANTTAP_CLAUDE_BIN;
    else process.env.GRANTTAP_CLAUDE_BIN = previousBin;
    if (previousConfig == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previousConfig;
  });
  const reply = await import(`../apps/bridge/src/reply.ts?claudeEdges=${Date.now()}`);
  const target = session("claude", "claude-existing", root);

  assert.deepEqual(await reply.deliverToSession(target, "json-error", 2_000), {
    ok: false, error: "blocked",
  });
  assert.deepEqual(await reply.deliverToSession(target, "json-default-error", 2_000), {
    ok: false, error: "agent error",
  });
  assert.deepEqual(await reply.deliverToSession(target, "plain", 2_000), {
    ok: true, text: "plain response",
  });
  assert.deepEqual(await reply.deliverToSession(target, "empty", 2_000), {
    ok: false, error: "Claude returned an empty response.",
  });
  assert.equal((await reply.createClaudeSession("json-ok", root, 2_000)).sessionId, "created");
  assert.deepEqual(await reply.createClaudeSession("json-error", root, 2_000), {
    ok: false, error: "blocked",
  });
  assert.deepEqual(await reply.createClaudeSession("plain", root, 2_000), {
    ok: true, text: "plain response",
  });
  assert.deepEqual(await reply.createClaudeSession("empty", root, 2_000), {
    ok: false, error: "Claude returned an empty response.",
  });
});

test("Codex delivery covers JSONL diagnostics, sandbox variants, and escaped MCP keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-reply-edges-"));
  const binary = await script(root, "codex.mjs", [
    "let input=''; process.stdin?.setEncoding('utf8');",
    "process.stdin?.on('data', chunk => input += chunk);",
    "process.stdin?.on('end', () => {",
    " if (input.includes('empty')) return;",
    " if (input.includes('raw')) return process.stdout.write('diagnostic text');",
    " process.stdout.write('not-json\\n');",
    " process.stdout.write(JSON.stringify({type:'thread.started',session_id:'fallback-thread'})+'\\n');",
    " process.stdout.write(JSON.stringify({item:{type:'agent_message',text:process.argv.slice(2).join('|')}})+'\\n');",
    "});",
  ].join("\n"));
  const previousBin = process.env.GRANTTAP_CODEX_BIN;
  const previousConfig = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CODEX_BIN = binary;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previousBin == null) delete process.env.GRANTTAP_CODEX_BIN;
    else process.env.GRANTTAP_CODEX_BIN = previousBin;
    if (previousConfig == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previousConfig;
  });
  const config = await import(`../apps/bridge/src/config.ts?codexEdges=${Date.now()}`);
  config.saveRuntimeConfig({
    sessionAccess: { workspace: "workspace", full: "full" },
    sessionMcpDisabled: { workspace: ['quote"slash\\'] },
  });
  const reply = await import(`../apps/bridge/src/reply.ts?codexEdges=${Date.now()}`);
  const workspace = await reply.deliverToSession(session("codex", "workspace", root), "go", 2_000);
  assert.equal(workspace.ok, true);
  if (workspace.ok) {
    assert.match(workspace.text, /sandbox_mode="workspace-write"/);
    assert.match(workspace.text, /mcp_servers\."quote\\"slash\\\\"\.enabled=false/);
  }
  const full = await reply.deliverToSession(session("codex", "full", root), "go", 2_000);
  assert.equal(full.ok, true);
  if (full.ok) assert.match(full.text, /sandbox_mode="danger-full-access"/);
  const raw = await reply.createCodexSession("raw", root, 2_000);
  assert.deepEqual(raw, { ok: true, text: "diagnostic text", sessionId: undefined });
  assert.deepEqual(await reply.createCodexSession("empty", root, 2_000), {
    ok: false, error: "Codex returned an empty response.",
  });
  assert.equal((await reply.createCodexSession("normal", root, 2_000)).sessionId, "fallback-thread");
  assert.equal((await reply.deliverToSession({ ...session("codex", "bad", root), agent: "other" as never }, "go")).ok, false);
});

test("process delivery reports spawn, exit, parse, and timeout failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-process-edges-"));
  const failed = await script(root, "failed.mjs", "process.stderr.write('fixture failed'); process.exit(7);");
  const slow = await script(root, "slow.mjs", "setTimeout(() => {}, 5_000);");
  assert.equal((await runProcess(join(root, "missing"), [], root, 100, () => ({ ok: true, text: "x" }))).ok, false);
  // This case is about how a non-zero exit is reported, not about how fast a
  // machine can start Node. A one-second deadline made it a race the fixture
  // lost under the load of a full run, and the failure then read as a timeout.
  assert.deepEqual(await runProcess(failed, [], root, 15_000, () => ({ ok: true, text: "x" })), {
    ok: false, error: `${failed} exited with code 7: fixture failed`,
  });
  assert.equal((await runProcess(slow, [], root, 20, () => ({ ok: true, text: "x" }))).ok, false);
});
