import assert from "node:assert/strict";
import test from "node:test";
import { recordedFileChanges } from "../changes";

const patch = "*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n-old\n+new\n+extra\n*** Add File: /repo/b.ts\n+created\n*** End Patch";
const row = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-09-28T00:00:00Z", payload });

test("confirmed native and literal orchestrated patches retain per-file changes", () => {
  const rows = [row("response_item", { type: "custom_tool_call", name: "functions.exec", call_id: "call",
    input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` }),
  row("response_item", { type: "custom_tool_call_output", call_id: "call", output: "Success. Updated the following files:\nM /repo/a.ts\nA /repo/b.ts" })];
  const changes = recordedFileChanges(rows).get("call");
  assert.equal(changes?.length, 2);
  assert.deepEqual(changes?.map((c) => [c.path, c.linesAdded, c.linesRemoved]), [["/repo/a.ts", 2, 1], ["/repo/b.ts", 1, 0]]);
  assert.ok(changes?.[0]?.diff.includes("-old\n+new"));
  assert.equal(recordedFileChanges(rows.slice(0, 1)).size, 0);
  assert.equal(recordedFileChanges([rows[0]!, row("response_item", { type: "custom_tool_call_output", call_id: "call", output: "Failed to apply patch" })]).size, 0);
  const secret = patch.replaceAll("/repo/a.ts", "/repo/.env");
  assert.ok(!recordedFileChanges([row("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "secret", input: secret }),
    row("response_item", { type: "custom_tool_call_output", call_id: "secret", output: "Success. Updated the following files" })]).get("secret")?.some((c) => c.path.endsWith(".env")));
});

test("Codex completed FileChange items are authoritative and failed items stay absent", () => {
  const item = { type: "FileChange", id: "edit-1", status: "completed", changes: {
    "/repo/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new", move_path: null },
    "/repo/b.ts": { type: "add", content: "created" },
    "/repo/.env": { type: "add", content: "private value" },
  } };
  const changes = recordedFileChanges([row("event_msg", { type: "item_completed", item })]);
  assert.deepEqual(changes.get("edit-1")?.map((c) => [c.path, c.linesAdded, c.linesRemoved]),
    [["/repo/a.ts", 1, 1], ["/repo/b.ts", 1, 0]]);
  assert.equal(recordedFileChanges([row("event_msg", { type: "item_completed", item: { ...item, status: "failed" } })]).size, 0);
});
