import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopTaskActivity } from "../../../apps/mcp/src/desktop/task-activity";
import { SessionActivity } from "../../../packages/protocol/schema";

test("desktop command details retain resource evidence without inventing model tokens", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-command-metrics-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const storePath = join(directory, "mesh.json");
  writeFileSync(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "p", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 }],
    tasks: [{ taskId: "t", projectId: "p", title: "Metrics", goal: "Test", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "t", sessionId: "s", provider: "claude", computerId: "computer", workspace: directory, startedAt: 1 }],
  }));
  const activity = SessionActivity.parse({ type: "session.activity", sessionId: "s", agent: "claude", state: "working", generatedAt: 3,
    entries: [{ id: "call", kind: "tool", text: "Bash: test", toolName: "Bash", createdAt: 2,
      durationMs: 10_000, estimatedContextTokens: 320,
      capabilities: [{ kind: "cli", name: "test", toolName: "Bash", durationMs: 10_000,
        resource: { attribution: "attributed", cpuTimeMs: 7_500, peakRssBytes: 300_000_000, sampleWindowMs: 10_000 } }] },
    { id: "legacy", kind: "tool", text: "Bash: old", createdAt: 1 }] });
  const result = desktopTaskActivity({ project_id: "p", task_id: "t" }, storePath, { activity: () => activity });
  assert.equal(result?.entries[0]?.duration_ms, 10_000);
  assert.equal(result?.entries[0]?.estimated_context_tokens, 320);
  assert.deepEqual(result?.entries[0]?.capabilities, activity.entries[0]?.capabilities);
  assert.equal(result?.entries[1]?.capabilities, undefined);
  assert.equal(result?.entries[1]?.duration_ms, undefined);
  assert.equal(result?.entries[1]?.estimated_context_tokens, undefined);
});
