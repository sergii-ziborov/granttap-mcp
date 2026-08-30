import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a home-screen phone message creates a persisted Codex task", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-codex-stub-"));
  const stub = join(dir, "codex-stub.mjs");
  await writeFile(
    stub,
    [
      "#!/usr/bin/env node",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => input += chunk);",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-from-phone' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Answer: ' + input } }) + '\\n');",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );

  const previous = process.env.GRANTTAP_CODEX_BIN;
  process.env.GRANTTAP_CODEX_BIN = stub;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CODEX_BIN;
    else process.env.GRANTTAP_CODEX_BIN = previous;
  });

  const { createCodexSession } = await import(`../apps/bridge/src/reply.ts?test=${Date.now()}`);
  const result = await createCodexSession("Hello from iPhone", dir, 5_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sessionId, "thread-from-phone");
  assert.equal(result.text, "Answer: Hello from iPhone");
});

test("a new task without a selected project uses an isolated GrantTap workspace", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-general-workspace-"));
  const configDir = join(dir, "config");
  const stub = join(dir, "codex-stub.mjs");
  await writeFile(stub, [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.cwd() } }) + '\\n');",
    "});",
  ].join("\n"), { mode: 0o755 });

  const previousBin = process.env.GRANTTAP_CODEX_BIN;
  const previousConfig = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CODEX_BIN = stub;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previousBin == null) delete process.env.GRANTTAP_CODEX_BIN;
    else process.env.GRANTTAP_CODEX_BIN = previousBin;
    if (previousConfig == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previousConfig;
  });

  const { createCodexSession } = await import(`../apps/bridge/src/reply.ts?general=${Date.now()}`);
  const result = await createCodexSession("General task", undefined, 5_000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text.endsWith("/config/workspaces/general-codex"), true);
});

test("a phone-selected access level is passed to the resumed Codex task", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-codex-access-stub-"));
  const configDir = join(dir, "config");
  const stub = join(dir, "codex-stub.mjs");
  await writeFile(
    stub,
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  const text = process.argv.slice(2).join('|');",
      "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );

  const previousBin = process.env.GRANTTAP_CODEX_BIN;
  const previousConfig = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CODEX_BIN = stub;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previousBin == null) delete process.env.GRANTTAP_CODEX_BIN;
    else process.env.GRANTTAP_CODEX_BIN = previousBin;
    if (previousConfig == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previousConfig;
  });

  const { saveRuntimeConfig } = await import(`../apps/bridge/src/config.ts?access=${Date.now()}`);
  saveRuntimeConfig({
    enabled: true,
    excludedSessions: [],
    sessionAccess: { "thread-access": "read-only" },
    sessionMcpDisabled: { "thread-access": ["github"] },
  });
  const { deliverToSession } = await import(`../apps/bridge/src/reply.ts?access=${Date.now()}`);
  const result = await deliverToSession(
    {
      sessionId: "thread-access",
      agent: "codex",
      state: "idle",
      startedAt: 1,
      lastActivityAt: 1,
      tokensSession: 0,
      tokensLastTurn: 0,
      cwd: dir,
    },
    "Use restricted access",
    5_000,
    [],
    { preferredMcp: "granttap", skill: "release-check", model: "gpt-5.6-terra" },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /exec\|resume\|-c\|sandbox_mode="read-only"\|-c\|mcp_servers\."github"\.enabled=false\|-m\|gpt-5.6-terra\|thread-access\|--json\|-/);
  assert.match(result.text, /mcp_servers\."github"\.enabled=false/);
});

test("an encrypted phone image becomes a Codex image input", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-codex-image-stub-"));
  const stub = join(dir, "codex-stub.mjs");
  await writeFile(
    stub,
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  const text = process.argv.slice(2).join('|');",
      "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );
  const previous = process.env.GRANTTAP_CODEX_BIN;
  process.env.GRANTTAP_CODEX_BIN = stub;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CODEX_BIN;
    else process.env.GRANTTAP_CODEX_BIN = previous;
  });

  const { createCodexSession } = await import(`../apps/bridge/src/reply.ts?image=${Date.now()}`);
  const result = await createCodexSession("Inspect it", dir, 5_000, [
    { name: "phone.jpg", mimeType: "image/jpeg", data: Buffer.from("image-bytes").toString("base64") },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /^exec\|-i\|\/.*granttap-attachments-.*\/1-phone\.jpg\|--json\|--skip-git-repo-check\|-/);
});

test("a phone image is passed to a new Claude Code task as local context", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-claude-image-stub-"));
  const stub = join(dir, "claude-stub.mjs");
  await writeFile(
    stub,
    [
      "#!/usr/bin/env node",
      "const prompt = process.argv.at(-1);",
      "process.stdout.write(JSON.stringify({ result: prompt, session_id: 'claude-from-phone' }));",
    ].join("\n"),
    { mode: 0o755 },
  );
  const previous = process.env.GRANTTAP_CLAUDE_BIN;
  process.env.GRANTTAP_CLAUDE_BIN = stub;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CLAUDE_BIN;
    else process.env.GRANTTAP_CLAUDE_BIN = previous;
  });

  const { createClaudeSession } = await import(`../apps/bridge/src/reply.ts?claudeImage=${Date.now()}`);
  const result = await createClaudeSession("Inspect it", dir, 5_000, [
    { name: "phone.jpg", mimeType: "image/jpeg", data: Buffer.from("image-bytes").toString("base64") },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sessionId, "claude-from-phone");
  assert.match(result.text, /Attached files available locally/);
  assert.match(result.text, /granttap-attachments-.*\/1-phone\.jpg/);
});
