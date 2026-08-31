import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  runProjectHook,
  startProjectPolicyEngine,
  stopProjectPolicyEngine,
  writeProjectHookRuntime,
} from "./project-policy-hook-harness";

test("Codex Project ASK is exact, single-use, and never waits in both hooks", async (t) => {
  const root = await projectRuntime(t, "granttap-codex-project-policy-");
  const askCall = codexCall("call-ask", "shell_command", { command: "echo safe" });
  const preTool = runProjectHook("codexPolicy", root, askCall);
  assert.equal(preTool.stdout, "", "PreToolUse records ASK without waiting on the phone");

  const permission = runProjectHook("codex", root, askCall);
  assert.equal(permission.value?.hookSpecificOutput?.decision?.behavior, "deny");
  assert.match(permission.stdout, /Project approval was required/);
  const replay = runProjectHook("codex", root, askCall);
  assert.equal(replay.value?.hookSpecificOutput?.decision?.behavior, "allow");

  const exact = codexCall("call-exact", "shell_command", { command: "npm test" });
  assert.equal(runProjectHook("codexPolicy", root, exact).stdout, "");
  const different = runProjectHook("codex", root, { ...exact, tool_use_id: "call-other" });
  assert.equal(different.value?.hookSpecificOutput?.decision?.behavior, "allow");
  assert.equal(
    runProjectHook("codex", root, exact).value?.hookSpecificOutput?.decision?.behavior,
    "deny",
  );
});

test("Codex Project DENY and unbindable ASK fail before provider approval", async (t) => {
  const root = await projectRuntime(t, "granttap-codex-project-deny-");
  const denied = runProjectHook("codexPolicy", root,
    codexCall("call-write", "Write", { file_path: "/work/project/a.ts" }));
  assert.equal(denied.value?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(denied.stdout, /requires deny/);

  const unbound = runProjectHook("codexPolicy", root, {
    session_id: "session", cwd: "/work/project", tool_name: "shell_command",
    tool_input: { command: "echo safe" },
  });
  assert.equal(unbound.value?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(unbound.stdout, /exact Codex call/);
});

test("Cursor Project policy precedes full auto for shell and redacted MCP", async (t) => {
  const root = await projectRuntime(t, "granttap-cursor-project-policy-");
  const shell = runProjectHook("cursor", root, {
    conversation_id: "cursor-chat",
    cwd: "/work/project",
    command: "echo safe",
  });
  assert.equal(shell.value?.permission, "deny");
  assert.match(shell.stdout, /Project approval was required/);

  const cursorDir = join(root, "cursor");
  await mkdir(cursorDir);
  await writeFile(join(cursorDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      github: { url: "https://token@example.test/mcp", headers: { Authorization: "secret" } },
    },
  }));
  const mcp = runProjectHook("cursorMcp", root, {
    conversation_id: "cursor-chat",
    workspace_roots: ["/work/project"],
    mcp_server_name: "github",
    tool_name: "create_issue",
    tool_input: { token: "must-not-cross-policy-ipc", body: "private" },
  }, { GRANTTAP_CURSOR_DIR: cursorDir });
  assert.equal(mcp.value?.permission, "deny");
  assert.match(mcp.stdout, /requires deny/);
  assert.doesNotMatch(mcp.stdout, /must-not-cross-policy-ipc|secret|token@example/);
});

function codexCall(
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session",
    tool_use_id: toolUseId,
    cwd: "/work/project",
    tool_name: toolName,
    tool_input: toolInput,
  };
}

async function projectRuntime(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const engine = await startProjectPolicyEngine(root);
  t.after(async () => {
    await stopProjectPolicyEngine(engine);
    await rm(root, { recursive: true, force: true });
  });
  await writeProjectHookRuntime(root);
  return root;
}
