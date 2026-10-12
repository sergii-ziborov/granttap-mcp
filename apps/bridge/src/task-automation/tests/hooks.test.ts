import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { grantTaskAutomation } from "..";
import { runProjectHook, startProjectPolicyEngine, stopProjectPolicyEngine,
  writeProjectHookRuntime } from "../../../../../tests/project-policy-hook-harness";

test("a confirmed chat exception answers ASK but cannot override DENY, pause, or a new revision", async t => {
  const root = await mkdtemp(join(tmpdir(), "granttap-auto-hook-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  const engine = await startProjectPolicyEngine(root);
  t.after(async () => { await stopProjectPolicyEngine(engine);
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true }); });
  await writeProjectHookRuntime(root);
  grantTaskAutomation("session", "project", 1, "except_push");
  const shell = { session_id: "session", cwd: "/work/project", tool_name: "Bash",
    tool_use_id: "shell-call", tool_input: { command: "echo safe" } };
  const claude = runProjectHook("claude", root, shell);
  assert.equal(claude.value?.hookSpecificOutput?.permissionDecision, "allow");
  runProjectHook("codexPolicy", root, shell);
  const codex = runProjectHook("codex", root, shell);
  assert.equal(codex.value?.hookSpecificOutput?.decision?.behavior, "allow");
  const blocked = runProjectHook("claude", root, { ...shell, tool_name: "Write",
    tool_input: { file_path: "/work/project/a.ts" } });
  assert.equal(blocked.value?.hookSpecificOutput?.permissionDecision, "deny");
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  await writeFile(join(root, "config.json"), JSON.stringify({ ...config, autoAcceptPaused: true }));
  assert.equal(runProjectHook("claude", root, shell).value?.hookSpecificOutput?.permissionDecision, "deny");
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  grantTaskAutomation("session", "project", 2, "full");
  assert.equal(runProjectHook("claude", root, shell).value?.hookSpecificOutput?.permissionDecision, "deny");
});
