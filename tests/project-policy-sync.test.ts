import assert from "node:assert/strict";
import test from "node:test";
import type { RelayClient } from "../packages/core/relay-client";
import {
  Payload,
  ProjectPolicyAck,
  ProjectPolicySet,
  ProjectPolicyStatus,
  type ProjectPolicy,
  type ProjectPolicyPayload,
  type ProjectPolicySet as ProjectPolicySetValue,
} from "../packages/protocol/schema";
import { ProjectPolicy as ProjectPolicySchema } from "../packages/protocol/messages/project-policy";
import type { EngineClientLike } from "../apps/bridge/src/engine/engine-supervisor";
import { rejectionReason } from "../apps/bridge/src/project-policy/runtime";
import {
  acknowledgementFromEngine,
  policyFromEngine,
  policyToEngine,
} from "../apps/bridge/src/project-policy/mapping";
import {
  createProjectPolicyRuntime,
  enforcementCoverageFor,
  projectPolicyFeatureEnabled,
} from "../apps/bridge/src/project-policy/runtime";

const now = 1_800_000_000_000;

function policySet(): ProjectPolicySetValue {
  return {
    type: "project.policy.set", sessionId: "project", projectId: "project",
    expectedRevision: 0,
    policy: {
      projectId: "project", revision: 1, enforcement: "strict",
      rules: [{
        ruleId: "deny-mcp", projectId: "project", selector: { kind: "mcp" },
        effect: "deny", conditions: { endpointIds: [], providers: [] },
        revision: 1, createdBy: "phone",
      }],
    },
    createdAt: now,
  };
}

test("Project policy wire stays project-scoped, strict, and bounded", () => {
  const value = policySet();
  assert.equal(ProjectPolicySet.safeParse(value).success, true);
  assert.equal(Payload.safeParse(value).success, true);
  assert.equal(ProjectPolicySet.safeParse({ ...value, sessionId: "other" }).success, false);
  assert.equal(ProjectPolicySet.safeParse({
    ...value, policy: { ...value.policy, projectId: "other" },
  }).success, false);
  assert.equal(ProjectPolicySet.safeParse({
    ...value,
    policy: { ...value.policy, rules: [{ ...value.policy.rules[0]!, effect: "inherit" }] },
  }).success, false);
  assert.equal(ProjectPolicySet.safeParse({
    ...value,
    policy: {
      ...value.policy,
      rules: [value.policy.rules[0]!, { ...value.policy.rules[0]! }],
    },
  }).success, false);

  const acknowledgement = {
    projectId: "project", policyRevision: 1, endpointId: "mac", provider: "claude" as const,
    capabilities: [{ kind: "mcp" as const, status: "enforced" as const }], observedAt: now,
  };
  const status = {
    type: "project.policy.status" as const, sessionId: "project", projectId: "project",
    policy: value.policy,
    coverage: {
      projectId: "project", policyRevision: 1, enforcement: "strict" as const,
      requiredCapabilities: ["mcp" as const], endpoints: [acknowledgement], strictReady: true,
    },
    generatedAt: now,
  };
  assert.equal(ProjectPolicyStatus.safeParse(status).success, true);
  assert.equal(ProjectPolicyStatus.safeParse({
    ...status, coverage: { ...status.coverage, projectId: "other" },
  }).success, false);
  assert.equal(ProjectPolicyStatus.safeParse({
    ...status,
    coverage: {
      ...status.coverage,
      endpoints: [{ ...acknowledgement, policyRevision: 2 }],
    },
  }).success, false);
  assert.equal(ProjectPolicyAck.safeParse({
    type: "project.policy.ack", sessionId: "project", projectId: "project", acknowledgement,
  }).success, true);
  assert.equal(ProjectPolicyAck.safeParse({
    type: "project.policy.ack", sessionId: "other", projectId: "project", acknowledgement,
  }).success, false);
  assert.equal(ProjectPolicyAck.safeParse({
    type: "project.policy.ack", sessionId: "project", projectId: "project",
    acknowledgement: {
      ...acknowledgement,
      capabilities: [acknowledgement.capabilities[0]!, acknowledgement.capabilities[0]!],
    },
  }).success, false);
});

test("fingerprinted rules round-trip without weakening identity evidence", () => {
  const digest = "a".repeat(64);
  const policy: ProjectPolicy = {
    projectId: "project", revision: 4, enforcement: "best_available",
    rules: [
      {
        ruleId: "exact-script", projectId: "project", effect: "allow", revision: 4,
        createdBy: "phone",
        selector: {
          kind: "script", displayName: "release", provider: "claude", origin: "plugin",
          fingerprint: {
            match: "changed_from",
            expected: {
              kind: "script", displayName: "release", provider: "cursor", origin: "plugin",
              publisher: "GrantTap", version: "1", transport: "stdio",
              executablePathHash: digest, configHash: digest, scriptHash: digest,
              confidence: "exact",
            },
          },
        },
        conditions: { endpointIds: ["mac"], providers: ["codex"], impact: "available" },
      },
      {
        ruleId: "unknown-mcp", projectId: "project", effect: "ask", revision: 4,
        createdBy: "phone", selector: {
          kind: "mcp", fingerprint: { match: "confidence", value: "unknown" },
        },
        conditions: { endpointIds: [], providers: [] },
      },
    ],
  };
  const engine = policyToEngine(policy);
  assert.deepEqual(JSON.parse(JSON.stringify(policyFromEngine(engine))), policy);
  engine.rules[0]!.selector.provider = "CLAUDE";
  engine.rules[0]!.conditions.providers = ["CODEX"];
  assert.equal(policyFromEngine(engine).rules[0]?.selector.provider, "claude");
  assert.throws(() => acknowledgementFromEngine({
    project_id: "project", policy_revision: 4, endpoint_id: "mac", provider: "future",
    capabilities: [], observed_at: now,
  }), /unsupported policy provider/);
});

test("coverage matrix never calls observed or unsupported providers enforced", () => {
  assert.equal(enforcementCoverageFor("claude", "skill"), "enforced");
  assert.equal(enforcementCoverageFor("cursor", "skill"), "unsupported");
  assert.equal(enforcementCoverageFor("cursor", "file_write"), "unsupported");
  assert.equal(enforcementCoverageFor("grok", "shell"), "observed");
  assert.equal(enforcementCoverageFor("grok", "mcp"), "unsupported");
  assert.equal(enforcementCoverageFor("claude", "mcp", false), "unknown");
});

test("Project policy rollout requires both engine and governance flags", () => {
  assert.equal(projectPolicyFeatureEnabled({}), false);
  assert.equal(projectPolicyFeatureEnabled({ GRANTTAP_ENGINE_ENABLED: "true" }), false);
  assert.equal(projectPolicyFeatureEnabled({
    GRANTTAP_ENGINE_ENABLED: "1", GRANTTAP_PROJECT_POLICY_ENABLED: "TRUE",
  }), true);
});

test("a policy set is applied, acknowledged per provider, and projected to phone", async () => {
  const operations: string[] = [];
  const sent: ProjectPolicyPayload[] = [];
  const client: EngineClientLike = {
    close() {},
    async request(operation) {
      operations.push(operation.operation);
      if (operation.operation === "policy.apply") {
        return { operation: "policy.applied", policy: operation.input.policy };
      }
      if (operation.operation === "policy.ack") {
        return {
          operation: "policy.acknowledged",
          acknowledgement: operation.input.acknowledgement,
        };
      }
      if (operation.operation === "policy.coverage") {
        return {
          operation: "policy.coverage",
          coverage: {
            project_id: "project", policy_revision: 1, enforcement: "strict",
            required_capabilities: ["mcp"], endpoints: [], strict_ready: false,
          },
        };
      }
      throw new Error(`unexpected ${operation.operation}`);
    },
  };
  const runtime = createProjectPolicyRuntime({
    client, endpointId: () => "mac", providers: () => [
      { provider: "claude", hookConfigured: true },
      { provider: "cursor", hookConfigured: true },
      { provider: "grok", hookConfigured: false },
    ],
    now: () => now,
    send: async (_relay, payload) => { sent.push(payload); },
  });

  assert.equal(await runtime.apply({} as RelayClient, policySet()), true);
  assert.deepEqual(operations, [
    "policy.apply", "policy.ack", "policy.ack", "policy.ack", "policy.coverage",
  ]);
  assert.equal(sent.filter((item) => item.type === "project.policy.ack").length, 3);
  const cursor = sent.find((item) =>
    item.type === "project.policy.ack" && item.acknowledgement.provider === "cursor");
  assert.equal(cursor?.type === "project.policy.ack"
    && cursor.acknowledgement.capabilities.find((item) => item.kind === "skill")?.status,
  "unsupported");
  assert.equal(sent.at(-1)?.type, "project.policy.status");
});

test("periodic projection is ordered, deduplicated, and reports unauthored policies", async () => {
  const operations: string[] = [];
  const sent: ProjectPolicyPayload[] = [];
  const client: EngineClientLike = {
    close() {},
    async request(operation) {
      const projectId = operation.operation === "policy.get"
        || operation.operation === "policy.coverage" ? operation.input.project_id : "";
      operations.push(`${operation.operation}:${projectId}`);
      if (operation.operation === "policy.get") {
        return {
          operation: "policy.found",
          policy: {
            project_id: projectId, revision: projectId === "empty" ? 0 : 2,
            enforcement: "best_available", rules: [],
          },
        };
      }
      if (operation.operation === "policy.coverage") {
        return {
          operation: "policy.coverage",
          coverage: {
            project_id: projectId, policy_revision: projectId === "empty" ? 0 : 2,
            enforcement: "best_available", required_capabilities: [],
            endpoints: [], strict_ready: true,
          },
        };
      }
      throw new Error("unexpected operation");
    },
  };
  const runtime = createProjectPolicyRuntime({
    client, endpointId: () => "mac", providers: () => [], now: () => now,
    send: async (_relay, payload) => { sent.push(payload); },
  });
  await runtime.publish({} as RelayClient, ["project", "empty", "project"]);
  assert.deepEqual(operations, [
    "policy.get:empty", "policy.coverage:empty",
    "policy.get:project", "policy.coverage:project",
  ]);
  // A Project with no policy is still reported, so the phone can author the
  // first revision instead of showing an empty Governance screen forever.
  assert.deepEqual(
    sent.map((item) => item.type),
    ["project.policy.status", "project.policy.status"],
  );
  assert.deepEqual(
    sent.map((item) => item.type === "project.policy.status" ? item.policy.revision : -1),
    [0, 2],
  );
});

test("a refused apply answers the phone with why, and with the policy the computer holds", async () => {
  const sent: ProjectPolicyPayload[] = [];
  const lines: string[] = [];
  const held = policyToEngine({ ...policySet().policy, revision: 1 });
  const client: EngineClientLike = {
    close() {},
    async request(operation) {
      if (operation.operation === "policy.apply") throw new Error("policy revision conflict: expected 1, got 0");
      if (operation.operation === "policy.get") return { operation: "policy.found", policy: held };
      if (operation.operation === "policy.coverage") {
        return {
          operation: "policy.coverage",
          coverage: {
            project_id: "project", policy_revision: 1, enforcement: held.enforcement,
            required_capabilities: [], endpoints: [], strict_ready: true,
          },
        };
      }
      throw new Error(`unexpected ${operation.operation}`);
    },
  };
  const runtime = createProjectPolicyRuntime({
    client, endpointId: () => "mac", providers: () => [], now: () => now,
    send: async (_relay, payload) => { sent.push(payload); },
    log: (line) => lines.push(line),
  });
  assert.equal(await runtime.apply({} as RelayClient, policySet()), false);
  assert.equal(sent[0]?.type, "project.policy.rejected");
  const rejected = sent[0] as Extract<ProjectPolicyPayload, { type: "project.policy.rejected" }>;
  assert.equal(rejected.reason, "revision_mismatch");
  assert.equal(rejected.currentRevision, 1);
  assert.equal(rejected.expectedRevision, policySet().expectedRevision);
  assert.equal(sent[1]?.type, "project.policy.status", "the policy the computer holds follows, so the next edit builds on it");
  assert.match(lines[0] ?? "", /could not apply revision \d+ of project \(revision_mismatch\)/);

  // An engine that is not there: the refusal still goes out, without a revision.
  const down: EngineClientLike = {
    close() {},
    async request() { throw new Error("connect ECONNREFUSED engine.sock"); },
  };
  const offline: ProjectPolicyPayload[] = [];
  const quiet = createProjectPolicyRuntime({
    client: down, endpointId: () => "mac", providers: () => [], now: () => now,
    send: async (_relay, payload) => { offline.push(payload); },
  });
  assert.equal(await quiet.apply({} as RelayClient, policySet()), false);
  assert.equal(offline.length, 1);
  const unavailable = offline[0] as Extract<ProjectPolicyPayload, { type: "project.policy.rejected" }>;
  assert.equal(unavailable.reason, "engine_unavailable");
  assert.equal(unavailable.currentRevision, undefined);
  assert.equal(rejectionReason(new Error("policy is invalid: bad selector")), "invalid_policy");
  assert.equal(rejectionReason("something else"), "unknown");
});

test("what the engine leaves null is absent on the wire, so the phone's strict shape check passes", () => {
  const policy = policyFromEngine({
    project_id: "project", revision: 1, enforcement: "best_available",
    rules: [{
      rule_id: "granttap-default-agent", project_id: "project",
      selector: { kind: "agent", display_name: null, provider: null, origin: null, fingerprint: null },
      effect: "allow",
      conditions: { endpoint_ids: [], providers: [], impact: null },
      revision: 1, created_by: "granttap-phone",
    }],
  } as never);
  assert.equal(JSON.stringify(policy).includes("null"), false);
  assert.deepEqual(policy.rules[0]?.selector, { kind: "agent" });
  assert.deepEqual(policy.rules[0]?.conditions, { endpointIds: [], providers: [] });
  assert.equal(ProjectPolicySchema.safeParse(policy).success, true);
});
