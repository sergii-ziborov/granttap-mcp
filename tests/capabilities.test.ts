import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("task capabilities expose configured MCP servers and repository skills", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-capabilities-"));
  const stub = join(dir, "codex-stub.mjs");
  const mcpStub = join(dir, "real-mcp-stub.mjs");
  await writeFile(mcpStub, [
    "let pending = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  pending += chunk;",
    "  for (;;) {",
    "    const newline = pending.indexOf('\\n');",
    "    if (newline < 0) break;",
    "    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);",
    "    if (!line.trim()) continue;",
    "    const request = JSON.parse(line);",
    "    if (request.method === 'initialize') process.stdout.write(JSON.stringify({",
    "      jsonrpc: '2.0', id: request.id, result: {",
    "        protocolVersion: '2025-11-25', capabilities: {},",
    "        serverInfo: {name: 'real-github-mcp', title: 'GitHub MCP', version: '9.1.0',",
    "          websiteUrl: 'https://example.test/mcp', icons: [{src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png', sizes: ['64x64']}]}",
    "      }",
    "    }) + '\\n');",
    "  }",
    "});",
    "process.stdin.on('end', () => process.exit(0));",
  ].join("\n"), { mode: 0o755 });
  await writeFile(
    stub,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([" +
      `{name:'github',enabled:true,auth_status:'bearer_token',transport:{type:'stdio',command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(mcpStub)}]}},` +
      "{name:'disabled-global',enabled:false,auth_status:'unsupported'}]));\n",
    { mode: 0o755 },
  );
  const skillDir = join(dir, ".agents", "skills", "release-check");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: release-check",
    "description: Verify a release before publishing.",
    "---",
    "# Release check",
  ].join("\n"));

  const previous = process.env.GRANTTAP_CODEX_BIN;
  process.env.GRANTTAP_CODEX_BIN = stub;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CODEX_BIN;
    else process.env.GRANTTAP_CODEX_BIN = previous;
  });

  const { mcpServersForSession, refreshMcpMetadataForSession, workspaceSkills } = await import(
    `../apps/bridge/src/capabilities.ts?test=${Date.now()}`
  );
  const session = {
    sessionId: "task-a",
    agent: "codex",
    cwd: dir,
    state: "idle" as const,
    startedAt: 1,
    lastActivityAt: 1,
    tokensSession: 0,
    tokensLastTurn: 0,
  };
  assert.deepEqual(mcpServersForSession(session, ["github"]), [
    {
      name: "disabled-global",
      configuredEnabled: false,
      allowed: false,
      authStatus: "unsupported",
    },
    {
      name: "github",
      configuredEnabled: true,
      allowed: false,
      authStatus: "bearer_token",
    },
  ]);
  await refreshMcpMetadataForSession(session);
  assert.deepEqual(mcpServersForSession(session, ["github"])[1], {
    name: "github",
    configuredEnabled: true,
    allowed: false,
    authStatus: "bearer_token",
    title: "GitHub MCP",
    websiteUrl: "https://example.test/mcp",
    version: "9.1.0",
    icons: [{
      src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      mimeType: "image/png",
      sizes: ["64x64"],
      theme: undefined,
    }],
    metadataSource: "mcp",
  });
  assert.deepEqual(workspaceSkills(dir), [
    { name: "release-check", description: "Verify a release before publishing." },
  ]);
});
