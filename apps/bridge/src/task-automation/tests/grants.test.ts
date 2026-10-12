import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { grantTaskAutomation, taskAutomationLevel, permitsProjectAskAutomation } from "..";

test("An explicit chat grant survives restart, stays in its project, and expires on a rule revision", t => {
  const dir = mkdtempSync(join(tmpdir(), "granttap-task-automation-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = dir;
  t.after(() => { process.env.GRANTTAP_CONFIG_DIR = previous; rmSync(dir, { recursive: true }); });
  grantTaskAutomation("chat", "project", 3, "except_push");
  assert.equal(taskAutomationLevel("chat", "project", 3), "except_push");
  assert.equal(taskAutomationLevel("chat", "different", 3), undefined);
  assert.equal(taskAutomationLevel("other-chat", "project", 3), undefined);
  assert.equal(taskAutomationLevel("chat", "project", 4), undefined);
  const ask = { effect: "ask", projectId: "project", policy_revision: 3, engineEvaluated: true } as const;
  assert.equal(permitsProjectAskAutomation(ask, "chat"), true);
  assert.equal(permitsProjectAskAutomation({ ...ask, effect: "deny" }, "chat"), false);
  assert.equal(permitsProjectAskAutomation({ ...ask, engineEvaluated: false }, "chat"), false);
  grantTaskAutomation("chat", "project", 3, null);
  assert.equal(taskAutomationLevel("chat", "project", 3), undefined);
});
