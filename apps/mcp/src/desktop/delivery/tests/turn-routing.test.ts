import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig, saveRuntimeConfig } from "../../../../../bridge/src/config";
import { desktopTaskSend } from "../task-send";

test("native replies preserve skill and permission choices and refuse disabled routing", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-local-turn-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const store = join(root, "project-mesh.json");
  const skillRoot = join(root, ".agents", "skills", "review");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: fixture-review\n---\nReview synthetic work.");
  writeFileSync(store, JSON.stringify({ version: 1,
    projects: [{ projectId: "p", name: "Fixture", createdAt: 1 }],
    tasks: [{ taskId: "t", projectId: "p", title: "Fixture", goal: "Synthetic", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "t", sessionId: "s", provider: "claude", computerId: "local", workspace: root, startedAt: 1 }],
  }));
  const calls: unknown[] = [];
  const deliver = async (_session: unknown, _text: string, _timeout?: number,
    _attachments?: unknown[], options?: unknown) => {
    calls.push(options);
    return { ok: true as const, text: "Synthetic result" };
  };
  const request = { project_id: "p", task_id: "t", session_id: "s", delivery_id: randomUUID(),
    text: "Synthetic request", skill: "fixture-review", permission_mode: "plan", effort: "high" };
  const result = await desktopTaskSend(request, store, deliver, "local") as { accepted: boolean };
  assert.equal(result.accepted, true);
  assert.deepEqual(calls, [{ skill: "fixture-review", permissionMode: "plan", effort: "high",
    messageId: request.delivery_id }]);
  const config = loadRuntimeConfig();
  config.sessionSkillsDisabled.s = ["fixture-review"];
  saveRuntimeConfig(config);
  const refused = await desktopTaskSend({ ...request, delivery_id: randomUUID() }, store, deliver, "local") as { accepted: boolean };
  assert.equal(refused.accepted, false);
  assert.equal(calls.length, 1);
  assert.equal(await desktopTaskSend({ ...request, permission_mode: "invalid" }, store, deliver, "local"), undefined);
});
