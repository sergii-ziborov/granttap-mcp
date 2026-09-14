import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capabilityFingerprint,
  carriesCoAuthorship,
  mcpCapabilityFingerprint,
} from "../apps/bridge/src/policy/capability-fingerprint";
import {
  evaluateEffectiveAction,
  legacyGrantTapFlowAllowed,
  projectPolicyFeatureEnabled,
} from "../apps/bridge/src/policy/effective-action";
import type { EngineClientLike } from "../apps/bridge/src/engine/engine-supervisor";
import type {
  EngineOperation,
} from "../apps/bridge/src/engine/engine-protocol";

// What the hook remembers about governed Projects lives in the config dir;
// these evaluations must not teach the person's own computer anything.
process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-effective-action-"));

test("artifact fingerprint changes when a script or skill changes at the same path", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-artifact-"));
  const script = join(root, "check.sh");
  writeFileSync(script, "echo one\n");
  const first = capabilityFingerprint({ provider: "claude", cwd: root,
    toolName: "Bash", toolInput: { command: "./check.sh" } });
  writeFileSync(script, "echo two\n");
  const second = capabilityFingerprint({ provider: "claude", cwd: root,
    toolName: "Bash", toolInput: { command: "./check.sh" } });
  assert.equal(first.executable_path_hash, second.executable_path_hash);
  assert.notEqual(first.script_hash, second.script_hash);
  const directory = join(root, ".agents", "skills", "example");
  mkdirSync(directory, { recursive: true });
  const definition = join(directory, "SKILL.md");
  writeFileSync(definition, "---\nname: example\n---\none\n");
  const oldSkill = capabilityFingerprint({ provider: "codex", cwd: root,
    toolName: "Skill", toolInput: { skill: "example" } });
  writeFileSync(definition, "---\nname: example\n---\ntwo\n");
  const newSkill = capabilityFingerprint({ provider: "codex", cwd: root,
    toolName: "Skill", toolInput: { skill: "example" } });
  assert.notEqual(oldSkill.script_hash, newSkill.script_hash);
});

const flags = {
  GRANTTAP_ENGINE_ENABLED: "1",
  GRANTTAP_PROJECT_POLICY_ENABLED: "1",
};

test("Project policy rollout requires both internal flags", () => {
  assert.equal(projectPolicyFeatureEnabled({}), false);
  assert.equal(projectPolicyFeatureEnabled({ GRANTTAP_ENGINE_ENABLED: "1" }), false);
  assert.equal(projectPolicyFeatureEnabled(flags), true);
});

test("legacy deny remains local and disabled rollout preserves legacy behavior", async () => {
  let calls = 0;
  const client = fakeClient(async () => {
    calls += 1;
    throw new Error("must not run");
  });
  const denied = await evaluateEffectiveAction({
    provider: "claude",
    legacyDenyReason: "GrantTap disabled CLI/shell for this chat",
  }, { env: flags, client });
  assert.equal(denied.effect, "deny");
  assert.equal(denied.source, "task");

  const fallback = await evaluateEffectiveAction({ provider: "claude" }, {
    env: {}, client, projectId: "project",
  });
  assert.equal(fallback.engineEvaluated, false);
  assert.equal(fallback.effect, "inherit");
  assert.equal(calls, 0);
});

test("workspace resolution and policy evaluation share one hard deadline", async () => {
  const calls: Array<{ operation: EngineOperation; timeoutMs?: number }> = [];
  const client = fakeClient(async (operation, options) => {
    calls.push({ operation, timeoutMs: options?.timeoutMs });
    if (operation.operation === "project.resolve") {
      return {
        operation: "project.resolved",
        resolution: { project_id: "project", compatibility_mode: false },
      };
    }
    if (operation.operation !== "policy.evaluate_action") throw new Error("unexpected operation");
    return {
      operation: "policy.evaluated",
      decision: {
        effect: "deny",
        source: "project",
        reason: "Project rule deny-write requires deny",
        rule_id: "deny-write",
        policy_revision: 4,
      },
    };
  });
  let time = 1_000;
  const decision = await evaluateEffectiveAction({
    provider: "claude",
    sessionId: "session",
    cwd: "/work/project/packages/api",
    toolName: "Write",
    toolInput: { file_path: "/work/project/.env", token: "must-not-cross-ipc" },
  }, {
    env: flags,
    client,
    endpointId: "mac",
    now: () => time++,
  });
  assert.equal(decision.effect, "deny");
  assert.equal(decision.projectId, "project");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.operation, {
    operation: "project.resolve",
    input: { endpoint_id: "mac", local_root: "/work/project/packages/api" },
  });
  assert.ok((calls[1]?.timeoutMs ?? 0) < (calls[0]?.timeoutMs ?? 0));
  const serialized = JSON.stringify(calls[1]?.operation);
  assert.doesNotMatch(serialized, /must-not-cross-ipc|\.env/);
  assert.match(serialized, /file_write/);
});

test("Project ASK and DENY cannot enter bypass, auto-accept, or skipped gating", async () => {
  for (const effect of ["ask", "deny"] as const) {
    const decision = await evaluateEffectiveAction({
      provider: "claude",
      toolName: "Bash",
      toolInput: { command: "echo safe" },
    }, {
      env: flags,
      projectId: "project",
      client: policyClient(effect),
    });
    assert.equal(decision.effect, effect);
    assert.equal(legacyGrantTapFlowAllowed(decision), false);
  }
  const allow = await evaluateEffectiveAction({ provider: "claude", toolName: "Read" }, {
    env: flags,
    projectId: "project",
    client: policyClient("allow"),
  });
  assert.equal(legacyGrantTapFlowAllowed(allow), true);
});

test("engine failure is explicit fallback for a Project never seen governed, and never an invented deny", async () => {
  const offline = fakeClient(async () => { throw new Error("offline"); });
  const decision = await evaluateEffectiveAction({ provider: "claude", toolName: "Write" }, {
    env: flags,
    projectId: "never-governed",
    client: offline,
  });
  assert.equal(decision.effect, "inherit");
  assert.equal(decision.engineEvaluated, false);
  // The Project the engine answered for above, with a policy revision, is
  // remembered as governed: the same failure there asks the person instead.
  const governed = await evaluateEffectiveAction({ provider: "claude", toolName: "Write" }, {
    env: flags,
    projectId: "project",
    client: offline,
  });
  assert.equal(governed.effect, "ask");
  assert.equal(governed.engineEvaluated, false);
});

test("a Project deny survives an engine that answers slowly", async () => {
  // The whole evaluation once had fifty milliseconds to connect, resolve the
  // Project, and decide. A busy machine missed that, fell back to legacy
  // behavior, and `inherit` reads as allowed — so enforcement held only while
  // nothing else was running.
  const seen: number[] = [];
  const client = fakeClient(async (operation, options) => {
    seen.push(options?.timeoutMs ?? 0);
    if (operation.operation !== "policy.evaluate_action") throw new Error("unexpected");
    return {
      operation: "policy.evaluated",
      decision: {
        effect: "deny",
        source: "project",
        reason: "Project rule deny-write requires deny",
        rule_id: "deny-write",
        policy_revision: 4,
      },
    };
  });
  // A machine slow enough to spend half a second before the question is asked.
  let time = 1_000;
  const decision = await evaluateEffectiveAction({ provider: "claude", toolName: "Write" }, {
    env: flags, projectId: "project", client, now: () => (time += 250),
  });
  assert.equal(decision.effect, "deny");
  assert.equal(legacyGrantTapFlowAllowed(decision), false);
  assert.ok(
    (seen[0] ?? 0) > 0,
    "the deadline still had room left after the machine spent half a second",
  );
});

test("capability fingerprints classify without retaining raw arguments", () => {
  const mcp = capabilityFingerprint({
    provider: "claude",
    toolName: "mcp__github__create_issue",
    toolInput: { token: "secret", body: "private prompt" },
  });
  assert.deepEqual(mcp, {
    kind: "mcp", display_name: "github", provider: "claude",
    origin: "mcp", confidence: "name_only",
  });
  assert.equal(capabilityFingerprint({
    provider: "claude", toolName: "Skill", toolInput: { skill: "release-check" },
  }).kind, "skill");
  assert.equal(capabilityFingerprint({
    provider: "claude", toolName: "Bash", toolInput: { command: "npm publish" },
  }).kind, "deploy");
  assert.equal(capabilityFingerprint({
    provider: "claude", toolName: "Bash", toolInput: { command: "./verify.sh" },
  }).display_name, "verify.sh");
  const plugin = capabilityFingerprint({
    provider: "claude", cwd: "/repo", toolName: "Bash",
    toolInput: { command: "bash ~/.claude/plugins/cache/superpowers/2.0/run.sh" },
  });
  assert.equal(plugin.kind, "skill");
  assert.equal(plugin.display_name, "superpowers");
  assert.match(plugin.executable_path_hash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(capabilityFingerprint({
    provider: "claude", toolName: "Bash",
    toolInput: { command: "bash ~/.claude/skills/release-check/run.sh" },
  }).kind, "skill");
  assert.equal(capabilityFingerprint({
    provider: "claude", toolName: "Bash",
    toolInput: { command: "env MODE=test bash ~/.claude/plugins/cache/superpowers/2.0/run.sh" },
  }).display_name, "superpowers");

  const configuredMcp = mcpCapabilityFingerprint("cursor", {
    serverName: "github", transport: "remote", configHash: "a".repeat(64),
  });
  assert.equal(configuredMcp.confidence, "exact");
  assert.equal(configuredMcp.config_hash, "a".repeat(64));
  assert.equal(mcpCapabilityFingerprint("cursor", {}).confidence, "unknown");
});

function policyClient(effect: "allow" | "ask" | "deny"): EngineClientLike {
  return fakeClient(async (operation) => {
    if (operation.operation !== "policy.evaluate_action") throw new Error("unexpected operation");
    return {
      operation: "policy.evaluated",
      decision: { effect, source: "project", reason: `Project requires ${effect}` },
    };
  });
}

function fakeClient(
  request: EngineClientLike["request"],
): EngineClientLike {
  return { request, close: () => undefined };
}

test("a shell call is fingerprinted by the command it runs, so one command can be governed alone", () => {
  const git = capabilityFingerprint({ provider: "claude", toolName: "Bash", toolInput: { command: "cd repo && git status" } });
  assert.equal(git.kind, "shell");
  assert.equal(git.display_name, "git");
  const bare = capabilityFingerprint({ provider: "claude", toolName: "Bash", toolInput: { command: "--flag" } });
  assert.equal(bare.display_name, "Shell");
});

test("a deploy or network call is fingerprinted by the phrase that made it one", () => {
  const push = capabilityFingerprint({ provider: "claude", toolName: "Bash", toolInput: { command: "git push origin main" } });
  assert.equal(push.kind, "deploy");
  assert.equal(push.display_name, "git push");
  assert.equal(capabilityFingerprint({ provider: "codex", toolName: "shell", toolInput: { command: "npm   publish --access public" } }).display_name, "npm publish");
  const curl = capabilityFingerprint({ provider: "claude", toolName: "Bash", toolInput: { command: "curl -s https://example.com" } });
  assert.equal(curl.kind, "network");
  assert.equal(curl.display_name, "curl");
});

test("a commit or PR that carries a co-authorship trailer is governed under its own name", () => {
  const coAuthored = capabilityFingerprint({
    provider: "claude", toolName: "Bash",
    toolInput: { command: "git commit -m \"Fix the thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\"" },
  });
  assert.equal(coAuthored.kind, "shell");
  assert.equal(coAuthored.display_name, "co-authorship");
  const generated = capabilityFingerprint({
    provider: "codex", toolName: "shell",
    toolInput: { command: "gh pr create --title x --body \"Done.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\"" },
  });
  assert.equal(generated.display_name, "co-authorship");
  // The same words outside a commit are not a trailer, and a plain commit is just git.
  assert.equal(capabilityFingerprint({ provider: "claude", toolName: "Bash", toolInput: { command: "grep -rn Co-Authored-By: docs/" } }).display_name, "grep");
  assert.equal(capabilityFingerprint({ provider: "claude", toolName: "Bash", toolInput: { command: "git commit -m \"Fix the thing\"" } }).display_name, "git");
  assert.equal(carriesCoAuthorship("git -C repo commit -F msg.txt"), false, "a message in a file cannot be read here");
});
