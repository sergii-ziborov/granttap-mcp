import assert from "node:assert/strict";
import test from "node:test";
import type { TaskCapsule } from "../../../../../packages/protocol/schema";
import { claudeCloudArgs, parseClaudeCloud } from "../claude";
import { codexCloudArgs, environmentForRepository, parseCodexCloud } from "../codex";
import { cloudFailure, cloudTaskPrompt, launchCloudRunner, type CloudCommand } from "../launch";

const capsule = (overrides: Partial<TaskCapsule> = {}): TaskCapsule => ({
  taskId: "task", goal: "Finish pairing", currentStatus: "Crypto complete", sourceProvider: "claude",
  sourceComputer: "MacBook", targetProvider: "claude", targetComputer: "MacBook",
  repository: "github.com/example/granttap", baseSha: "a".repeat(40), latestCommit: "b".repeat(40),
  branch: "feature/pairing", workingTree: "dirty", filesChanged: ["src/a.ts"], dependencies: [],
  resourceClaims: [], remainingWork: ["Run the tests"], importantDecisions: ["Keep the wire format"],
  userComment: "Start with the failing test.", createdAt: 1, ...overrides,
});

test("the cloud prompt carries the capsule's facts and says what stayed behind", () => {
  const prompt = cloudTaskPrompt(capsule(), "MacBook");
  for (const fact of ["Finish pairing", "Crypto complete", "github.com/example/granttap", "feature/pairing",
    "b".repeat(40), "Start with the failing test.", "Run the tests", "Keep the wire format"]) {
    assert.ok(prompt.includes(fact), fact);
  }
  assert.match(prompt, /uncommitted work on MacBook did not travel/);
  assert.doesNotMatch(cloudTaskPrompt(capsule({ workingTree: "clean" }), "MacBook"), /did not travel/);
  assert.ok(cloudTaskPrompt(capsule({ goal: "x".repeat(1_000), remainingWork: Array(32).fill("y".repeat(1_000)) }), "Mac")
    .length <= 12_000, "a bounded argument");
});

test("Claude cloud runs headless with the chosen branch, model and effort, and reports its own link", () => {
  assert.deepEqual(claudeCloudArgs({ prompt: "Continue", branch: "feature/x", title: "Pairing", model: "opus", effort: "xhigh" }),
    ["--cloud", "Continue", "--name", "Pairing", "--ref", "feature/x", "--model", "opus", "--effort", "xhigh"]);
  assert.deepEqual(claudeCloudArgs({ prompt: "Continue", effort: "ultra" }), ["--cloud", "Continue"]);
  assert.deepEqual(parseClaudeCloud("Created cloud session: Pairing\nSession ID: cse_01AbC\nView: https://claude.ai/code/cse_01AbC?m=0\nResume with: claude --teleport cse_01AbC\n"),
    { reference: "cse_01AbC", url: "https://claude.ai/code/cse_01AbC?m=0" });
  assert.deepEqual(parseClaudeCloud(JSON.stringify({ ok: true, session_id: "session_9", url: "https://claude.ai/code/session_9" })),
    { reference: "session_9", url: "https://claude.ai/code/session_9" });
  assert.deepEqual(parseClaudeCloud("Resume with: claude --teleport cse_2\n"), { reference: "cse_2" });
  assert.equal(parseClaudeCloud("Session ID: $(rm -rf)\nView: javascript:alert(1)"), undefined);
  assert.equal(parseClaudeCloud(""), undefined);
});

test("Codex Cloud submits to an environment and branch and reports the task it created", () => {
  assert.deepEqual(codexCloudArgs({ prompt: "Continue", environment: "example/granttap", branch: "feature/x" }),
    ["cloud", "exec", "--env", "example/granttap", "--branch", "feature/x", "Continue"]);
  assert.deepEqual(parseCodexCloud("Submitted https://chatgpt.com/codex/tasks/task_e_0123abcd\n"),
    { reference: "task_e_0123abcd", url: "https://chatgpt.com/codex/tasks/task_e_0123abcd" });
  assert.deepEqual(parseCodexCloud("Created task task_e_99ff"), { reference: "task_e_99ff" });
  assert.equal(parseCodexCloud("nothing useful"), undefined);
  const tasks = JSON.stringify({ tasks: [
    { id: "task_e_1", title: "private title", environment_id: "env_a", environment_label: "example/granttap" },
    { id: "task_e_2", environment_id: "env_a", environment_label: "example/granttap" },
    { id: "task_e_3", environment_id: "env_b", environment_label: "other/repo" },
  ] });
  assert.equal(environmentForRepository(tasks, "github.com/example/granttap"), "env_a");
  assert.equal(environmentForRepository(tasks, "git@github.com:example/GrantTap.git"), "env_a");
  assert.equal(environmentForRepository(tasks, "github.com/nobody/else"), undefined, "never a guess");
  assert.equal(environmentForRepository(JSON.stringify([{ environment_label: "granttap" }]), "github.com/example/granttap"), "granttap");
  assert.equal(environmentForRepository(JSON.stringify({ tasks: [
    { environment_id: "env_a", environment_label: "granttap" }, { environment_id: "env_c", environment_label: "granttap" },
  ] }), "github.com/example/granttap"), undefined, "an ambiguous label is not chosen for the person");
  assert.equal(environmentForRepository("not json", "github.com/example/granttap"), undefined);
});

test("a CLI failure is relayed in its own words without echoing the task", () => {
  assert.equal(cloudFailure("Claude cloud", { code: 1, stdout: "", stderr: "Error: Unable to create cloud session\nmore" }, "Continue the Task"),
    "Claude cloud did not start: Error: Unable to create cloud session");
  assert.equal(cloudFailure("Codex Cloud", { code: 1, stdout: "", stderr: "Error: Continue the Task was rejected" }, "Continue the Task"),
    "Codex Cloud did not start. Check the provider's cloud settings on this computer.");
  assert.equal(cloudFailure("Claude cloud", { code: null, stdout: "", stderr: "" }, "x"),
    "Claude cloud did not start. Check the provider's cloud settings on this computer.");
});

test("launch runs only the provider CLI, with the capsule prompt, and never reports a run it did not see", async () => {
  const calls: CloudCommand[] = [];
  const ok = (stdout: string) => async (command: CloudCommand) => { calls.push(command); return { code: 0, stdout, stderr: "" }; };
  const claude = await launchCloudRunner({ provider: "claude", cwd: "/repo", capsule: capsule(), computer: "MacBook",
    title: "Pairing", model: "opus", effort: "high" }, ok("Session ID: cse_1\nView: https://claude.ai/code/cse_1\n"),
  { claude: "/bin/claude", codex: "/bin/codex" });
  assert.deepEqual(claude, { ok: true, reference: "cse_1", url: "https://claude.ai/code/cse_1" });
  assert.equal(calls[0]!.binary, "/bin/claude");
  assert.equal(calls[0]!.cwd, "/repo");
  assert.ok(calls[0]!.args[1]!.includes("Finish pairing"));
  const unparsed = await launchCloudRunner({ provider: "claude", cwd: "/repo", capsule: capsule(), computer: "Mac" },
    ok("Something else"), { claude: "/bin/claude", codex: "/bin/codex" });
  assert.equal(unparsed.ok, false, "no session id means no claimed cloud run");
  const interactive = await launchCloudRunner({ provider: "claude", cwd: "/repo", capsule: capsule(), computer: "Mac" },
    async () => ({ code: 1, stdout: "", stderr: "No cloud session was created or opened: it would open in this terminal and need the keyboard.\n" }),
    { claude: "/bin/claude", codex: "/bin/codex" });
  assert.deepEqual(interactive, { ok: false, error: "Claude cloud did not start: No cloud session was created or opened: it would open in this terminal and need the keyboard." });

  calls.length = 0;
  const codex = await launchCloudRunner({ provider: "codex", cwd: "/repo", capsule: capsule(), computer: "Mac",
    environment: "env_a" }, ok("https://chatgpt.com/codex/tasks/task_e_42"), { claude: "/bin/claude", codex: "/bin/codex" });
  assert.deepEqual(codex, { ok: true, reference: "task_e_42", url: "https://chatgpt.com/codex/tasks/task_e_42" });
  assert.deepEqual(calls[0]!.args.slice(0, 6), ["cloud", "exec", "--env", "env_a", "--branch", "feature/pairing"]);

  calls.length = 0;
  const discovered = await launchCloudRunner({ provider: "codex", cwd: "/repo", capsule: capsule(), computer: "Mac" },
    async (command) => { calls.push(command); return command.args[1] === "list"
      ? { code: 0, stdout: JSON.stringify({ tasks: [{ environment_id: "env_a", environment_label: "example/granttap" }] }), stderr: "" }
      : { code: 0, stdout: "https://chatgpt.com/codex/tasks/task_e_7", stderr: "" }; },
    { claude: "/bin/claude", codex: "/bin/codex" });
  assert.equal(discovered.ok, true);
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [["cloud", "list"], ["cloud", "exec"]]);
  assert.equal(calls[1]!.args[3], "env_a");
  const unnamed = await launchCloudRunner({ provider: "codex", cwd: "/repo", capsule: capsule(), computer: "Mac" },
    async () => ({ code: 0, stdout: "{\"tasks\":[]}", stderr: "" }), { claude: "/bin/claude", codex: "/bin/codex" });
  assert.equal(unnamed.ok, false);
  assert.match(unnamed.ok ? "" : unnamed.error, /Codex Cloud environment/);
});
