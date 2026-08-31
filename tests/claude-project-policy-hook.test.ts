import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runProjectHook,
  startProjectPolicyEngine,
  stopProjectPolicyEngine,
  writeProjectHookRuntime,
} from "./project-policy-hook-harness";

test("Claude Project DENY and ASK precede bypass and auto-accept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-claude-project-policy-"));
  const engine = await startProjectPolicyEngine(root);
  t.after(async () => {
    await stopProjectPolicyEngine(engine);
    await rm(root, { recursive: true, force: true });
  });
  await writeProjectHookRuntime(root);

  const deny = runProjectHook("claude", root, {
    session_id: "session", cwd: "/work/project", tool_name: "Write",
    tool_input: { file_path: "/work/project/a.ts" }, permission_mode: "bypassPermissions",
  });
  assert.equal(deny.value?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(deny.stdout, /Project test policy requires deny/);

  const ask = runProjectHook("claude", root, {
    session_id: "session", cwd: "/work/project", tool_name: "Bash",
    tool_input: { command: "echo safe" }, permission_mode: "bypassPermissions",
  });
  assert.equal(ask.value?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(ask.stdout, /Project approval was required/);

  const allow = runProjectHook("claude", root, {
    session_id: "session", cwd: "/work/project", tool_name: "Read",
    tool_input: { file_path: "/work/project/a.ts" }, permission_mode: "bypassPermissions",
  });
  assert.equal(allow.stdout, "");
});
