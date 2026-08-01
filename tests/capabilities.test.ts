import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("task capabilities expose configured MCP servers and repository skills", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-capabilities-"));
  const stub = join(dir, "codex-stub.mjs");
  await writeFile(
    stub,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([" +
      "{name:'github',enabled:true,auth_status:'bearer_token'}," +
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

  const { mcpServersForSession, workspaceSkills } = await import(
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
  assert.deepEqual(workspaceSkills(dir), [
    { name: "release-check", description: "Verify a release before publishing." },
  ]);
});
