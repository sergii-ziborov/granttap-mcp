import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopTaskActivity } from "../../../apps/mcp/src/desktop/task-activity";
import { desktopTaskImage } from "../../../apps/mcp/src/desktop/image";
import { pushEntry } from "../../../apps/bridge/src/sessions/support/activity-helpers";
import type { ActivityEntry } from "../../../packages/protocol/schema";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
function fixture(t: { after: (fn: () => void) => void }, text?: string, rows?: ActivityEntry[]) {
  const root = mkdtempSync(join(tmpdir(), "granttap-artifact-images-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const image = join(workspace, "first light.png");
  writeFileSync(image, png);
  const storePath = join(root, "mesh.json");
  writeFileSync(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "project", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 }],
    tasks: [{ taskId: "task", projectId: "project", title: "Images", goal: "Test", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "task", sessionId: "session", provider: "codex", computerId: "computer", workspace, startedAt: 1 }],
  }));
  const entries = rows ?? [{ id: "reply", kind: "message" as const,
    text: text ?? `Generated:\n\n- [first light.png](<${image}>)`, createdAt: 2 }];
  const activity = desktopTaskActivity({ project_id: "project", task_id: "task" }, storePath, {
    activity: () => ({ type: "session.activity", sessionId: "session", agent: "codex",
      state: "working", generatedAt: 3, entries }),
  });
  return { root, workspace, image, storePath, activity, entries };
}
function images(activity: ReturnType<typeof desktopTaskActivity>) {
  return (activity?.entries[0] as unknown as { images?: Array<{ id: string; name: string; markdown: string }> })?.images ?? [];
}
function request(id: string, offset: unknown = 0) {
  return { project_id: "project", task_id: "task", image_id: id, offset };
}

test("visible replies retain all fifteen artifact links beyond preview limits", () => {
  const text = "Generated all badges.\n" + Array.from({ length: 15 }, (_, i) =>
    `- [badge-${i}.png](/workspace/artwork/generated/badge-${i}.png)`).join("\n");
  const out: ActivityEntry[] = [];
  pushEntry({ out, seen: new Set(), sessionId: "s", kind: "message", text, createdAt: 1, ordinal: 0 });
  assert.equal(out[0]?.text, text);
});

test("desktop preserves complete replies and advertises scoped image previews", (t) => {
  const text = "Long reply.\n" + "Details.\n".repeat(400) + "![Badge](first%20light.png)";
  const f = fixture(t, text);
  assert.equal(f.activity?.entries[0]?.text, text);
  assert.equal(images(f.activity).length, 1);
  assert.equal(images(f.activity)[0]?.name, "first light.png");
  const chunk = desktopTaskImage(request(images(f.activity)[0]!.id), f.storePath, f.activity);
  assert.equal(chunk?.mime_type, "image/png");
  assert.deepEqual(Buffer.from(chunk?.data_base64 ?? "", "base64"), png);
});

test("image chunks require the matching Task, advertised link and workspace", (t) => {
  const f = fixture(t);
  const id = images(f.activity)[0]?.id;
  assert.ok(id);
  assert.equal(desktopTaskImage({ ...request(id), task_id: "other" }, f.storePath, f.activity), undefined);
  assert.equal(desktopTaskImage({ ...request(id), project_id: "other" }, f.storePath, f.activity), undefined);
  assert.equal(desktopTaskImage(request("unlisted.png"), f.storePath, f.activity), undefined);
  assert.equal(desktopTaskImage(request(id, -1), f.storePath, f.activity), undefined);
  assert.equal(desktopTaskImage(request(id, png.length), f.storePath, f.activity), undefined);
  assert.equal(desktopTaskImage(request(id, 1.5), f.storePath, f.activity), undefined);
  assert.equal(desktopTaskImage(request(id, "bad"), f.storePath, f.activity), undefined);
  assert.deepEqual(Buffer.from(desktopTaskImage(request(id, "8"), f.storePath, f.activity)?.data_base64 ?? "", "base64"), png.subarray(8));
  assert.equal(desktopTaskImage(null, f.storePath), undefined);
  assert.equal(desktopTaskImage([], f.storePath), undefined);
});

test("linked images do not expose files outside the execution or nonimages", (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside.png");
  writeFileSync(outside, png);
  symlinkSync(outside, join(f.workspace, "escape.png"));
  writeFileSync(join(f.workspace, "fake.png"), "not an image");
  writeFileSync(join(f.workspace, "huge.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
  f.entries[0]!.text = "[outside](../outside.png) [escape](escape.png) [fake](fake.png) [huge](huge.png) [missing](missing.png)";
  const activity = desktopTaskActivity({ project_id: "project", task_id: "task" }, f.storePath, {
    activity: () => ({ type: "session.activity", sessionId: "session", agent: "codex", state: "working", generatedAt: 3, entries: f.entries }),
  });
  assert.equal(images(activity).length, 5);
  for (const item of images(activity)) assert.equal(desktopTaskImage(request(item.id), f.storePath, activity), undefined);
});

test("code examples and remote links are not local image attachments", (t) => {
  const f = fixture(t, "```md\n[code](first%20light.png)\n```\n`[inline](first%20light.png)`\n[remote](https://example.com/a.png) [document](notes.pdf)\n[valid](file:///tmp/a.png)\n[broken](%zz.png)");
  assert.equal(images(f.activity).length, 1);
  assert.equal(images(f.activity)[0]?.name, "a.png");
});

test("long conversations stay within the desktop frame and keep newest messages", (t) => {
  const rows = Array.from({ length: 256 }, (_, i): ActivityEntry => ({
    id: `row-${i}`, kind: "message", text: "Я".repeat(16_000), createdAt: i,
  }));
  const f = fixture(t, undefined, rows);
  assert.ok(Buffer.byteLength(JSON.stringify(f.activity)) < 500 * 1024);
  assert.equal(f.activity?.entries.at(-1)?.id, "row-255");
  assert.equal(f.activity?.entries.at(-1)?.text, rows.at(-1)?.text);
  assert.equal(f.activity?.truncated, true);
});
