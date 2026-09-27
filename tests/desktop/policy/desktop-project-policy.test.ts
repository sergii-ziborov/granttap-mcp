import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopProjectPolicy } from "../../../apps/mcp/src/desktop/policy";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "desktop-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = join(root, "mesh.json");
  await writeFile(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "mesh-a", name: "A", canonicalRepositoryId: "repo", createdAt: 1 }],
    bindings: [{ bindingId: "binding", projectId: "mesh-a", endpointId: "mac",
      repositoryId: "repo", displayName: "repo", available: true, localPathHint: root }],
  }));
  return storePath;
}

function engine() {
  let policy = { project_id: "mesh-a", revision: 0, enforcement: "best_available", rules: [] };
  const calls: string[] = [];
  return { calls, request: async (query: any) => {
    calls.push(query.operation);
    if (query.operation === "policy.get") return { operation: "policy.found", policy };
    if (query.operation === "policy.apply") {
      if (query.input.expected_revision !== policy.revision) throw new Error("revision conflict");
      policy = query.input.policy;
      return { operation: "policy.applied", policy };
    }
    return { operation: "policy.coverage", coverage: { project_id: "mesh-a",
      policy_revision: policy.revision, enforcement: policy.enforcement,
      required_capabilities: [], endpoints: [], strict_ready: false } };
  } };
}

const request = { type: "project.policy.set", sessionId: "mesh-a", projectId: "mesh-a",
  expectedRevision: 0, createdAt: 1, policy: { projectId: "mesh-a", revision: 1,
    enforcement: "best_available", rules: [{ ruleId: "deny-shell", projectId: "mesh-a",
      revision: 1, createdBy: "granttap-mac", effect: "deny", selector: { kind: "shell" },
      conditions: { endpointIds: [], providers: [] } }] } };

test("local Mesh can read revision zero and author its first policy", async (t) => {
  const storePath = await fixture(t);
  const client = engine();
  const options = { storePath, endpointId: "mac", engine: client as never, providers: () => [] };
  const before = await desktopProjectPolicy("desktop.policy_status", { project_id: "mesh-a" }, options);
  assert.equal(before?.payloads[0]?.type, "project.policy.status");
  assert.equal((before?.payloads[0] as any).policy.revision, 0);
  const applied = await desktopProjectPolicy("desktop.policy_set", {
    project_id: "mesh-a", request: JSON.stringify(request),
  }, options);
  assert.equal(applied?.accepted, true);
  assert.equal((applied?.payloads[0] as any).policy.rules[0].effect, "deny");
  assert.equal((applied?.payloads[0] as any).policy.revision, 1);
  const conflict = await desktopProjectPolicy("desktop.policy_set", {
    project_id: "mesh-a", request: JSON.stringify(request),
  }, options);
  assert.equal(conflict?.accepted, false);
  assert.equal(conflict?.payloads.find((p) => p.type === "project.policy.rejected")?.reason,
    "revision_mismatch");
});

test("local policy rejects foreign Meshes, endpoints and malformed edits before Engine writes", async (t) => {
  const storePath = await fixture(t);
  const client = engine();
  const options = { storePath, endpointId: "mac", engine: client as never, providers: () => [] };
  for (const input of [null, [], { project_id: "other" }, { project_id: "mesh-a", request: "{" },
    { project_id: "mesh-a", request: JSON.stringify({ ...request, projectId: "other" }) }]) {
    assert.equal(await desktopProjectPolicy("desktop.policy_set", input, options), undefined);
  }
  assert.equal(await desktopProjectPolicy("desktop.policy_status", { project_id: "mesh-a" },
    { ...options, endpointId: "foreign" }), undefined);
  assert.deepEqual(client.calls, []);
});

test("policy status retries a transient Engine read instead of leaving the editor empty", async (t) => {
  const storePath = await fixture(t);
  const client = engine();
  let failures = 2;
  const options = { storePath, endpointId: "mac", providers: () => [], engine: {
    request: async (query: any) => {
      if (failures-- > 0) throw new Error("Engine waking");
      return client.request(query);
    },
  } as never };
  const result = await desktopProjectPolicy("desktop.policy_status", { project_id: "mesh-a" }, options);
  assert.equal(result?.payloads[0]?.type, "project.policy.status");
});
