import assert from "node:assert/strict";
import test from "node:test";
import { capabilityFingerprint } from "../apps/bridge/src/policy/capability-fingerprint";
import {
  evaluateEffectiveAction,
  legacyGrantTapFlowAllowed,
  projectPolicyFeatureEnabled,
} from "../apps/bridge/src/policy/effective-action";
import type { EngineClientLike } from "../apps/bridge/src/engine/engine-supervisor";
import type {
  EngineOperation,
} from "../apps/bridge/src/engine/engine-protocol";

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

test("engine failure is explicit fallback and never becomes an invented deny", async () => {
  const decision = await evaluateEffectiveAction({ provider: "claude", toolName: "Write" }, {
    env: flags,
    projectId: "project",
    client: fakeClient(async () => { throw new Error("offline"); }),
  });
  assert.equal(decision.effect, "inherit");
  assert.equal(decision.engineEvaluated, false);
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
