import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveRuntimeConfig } from "../../../apps/bridge/src/config";
import { executionCapabilityFor } from "../../../apps/bridge/src/mesh/catalog/capability";
import { computerId } from "../../../apps/bridge/src/mesh/identity/computer";
import { localMeshStore, resetLocalMeshStore } from "../../../apps/bridge/src/mesh/local-remote/local";
import { readScopedSkill } from "../../../apps/mcp/src/mcp-tools/mesh/skills/resource";

test("a scoped MCP client reads the verified Project SKILL.md only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-project-skill-resource-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  resetLocalMeshStore();
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    resetLocalMeshStore();
  });
  saveRuntimeConfig({ meshEnabled: true });
  const endpointId = computerId();
  const workspace = join(root, "repo");
  const bundle = join(workspace, ".agents", "skills", "review");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "SKILL.md"), "---\nname: review\n---\nReview this Project.\n");
  const now = Date.now();
  const store = localMeshStore();
  store.upsertProject({ projectId: "project", name: "Project", repositoryRoot: workspace,
    canonicalRepositoryId: "repo", createdAt: now });
  store.upsertBinding({ bindingId: "local", projectId: "project", endpointId,
    repositoryId: "repo", displayName: "Repository", localPathHint: workspace, available: true });
  store.upsertTask({ taskId: "task", projectId: "project", title: "Review", goal: "Review",
    state: "working", ownerSessionId: "native", createdAt: now, updatedAt: now });
  store.linkExecution({ taskId: "task", sessionId: "native", provider: "codex",
    computerId: endpointId, workspace, startedAt: now });
  const token = executionCapabilityFor("native")?.token;
  assert.ok(token);
  const uri = new URL(`granttap://mesh/${token}/skills/review`);
  const content = readScopedSkill(uri, token, "review");
  assert.match(content.contents[0]!.text, /Review this Project/);
  const foreign = readScopedSkill(uri, "invalid", "review");
  assert.match(foreign.contents[0]!.text, /available":false/);
  const missing = readScopedSkill(uri, token, "missing");
  assert.match(missing.contents[0]!.text, /available":false/);
  const priorHome = process.env.HOME;
  t.after(() => {
    if (priorHome == null) delete process.env.HOME;
    else process.env.HOME = priorHome;
  });
  process.env.HOME = join(root, "home");
  const homeBundle = join(process.env.HOME, ".agents", "skills", "review");
  mkdirSync(homeBundle, { recursive: true });
  writeFileSync(join(homeBundle, "SKILL.md"), "---\nname: review\n---\nReview this Project.\n");
  rmSync(join(bundle, "SKILL.md"));
  const shadowed = readScopedSkill(uri, token, "review");
  assert.match(shadowed.contents[0]!.text, /available":false/);
});
