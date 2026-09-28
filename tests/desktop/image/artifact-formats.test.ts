import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactImages, artifactImageChunk } from "../../../apps/mcp/src/desktop/image/artifacts";
import { pushEntry } from "../../../apps/bridge/src/sessions/support/activity-helpers";
import type { ActivityEntry } from "../../../packages/protocol/schema";

test("image lists support absolute, relative, file URLs, spaces and parenthesised filenames", () => {
  const paths = ["/work/one.png", "./two.jpg", "<folder/three four.webp>", "file:///work/five.jpeg", "six(seven).png", "eight\\(nine\\).png"];
  const entry = { id: "entry", kind: "final", text: paths.map((path) => `[Image](${path})`).join("\n") };
  const refs = artifactImages(entry);
  assert.deepEqual(refs.map((ref) => ref.name), ["one.png", "two.jpg", "three four.webp", "five.jpeg", "six(seven).png", "eight(nine).png"]);
  assert.equal(new Set(refs.map((ref) => ref.id)).size, 6);
  assert.equal(artifactImages({ ...entry, text: `${entry.text}\n[duplicate](/work/one.png)` }).length, 6);
  assert.deepEqual(artifactImages({ ...entry, kind: "tool" }), []);
  assert.deepEqual(artifactImages({ ...entry, text: "[bad](x.png\n [bad](file://server/x.png) [bad](bad%00.png)" }), []);
  assert.equal(artifactImages({ ...entry, text: Array.from({ length: 40 }, (_, i) => `[${i}](${i}.png)`).join("\n") }).length, 32);
});

test("actual image formats and byte chunks are bounded independently of filename extensions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-artifact-formats-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const storePath = join(root, "mesh.json");
  const state = { version: 1,
    projects: [{ projectId: "p", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 }],
    tasks: [{ taskId: "t", projectId: "p", title: "Test", goal: "Test", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "t", sessionId: "s", provider: "claude", computerId: "c", workspace, startedAt: 1 }],
  };
  writeFileSync(storePath, JSON.stringify(state));
  const input = { projectId: "p", taskId: "t", sessionId: "s", provider: "claude", offset: 0, storePath };
  const bytes = Buffer.alloc(100_000);
  bytes[0] = 255; bytes[1] = 216; bytes[2] = 255;
  const path = join(workspace, "image.jpg");
  writeFileSync(path, bytes);
  const image = artifactImages({ id: "entry", kind: "message", text: `[Photo](${path})` })[0]!;
  const first = artifactImageChunk({ ...input, image });
  assert.equal(first?.mime_type, "image/jpeg");
  assert.equal(Buffer.from(first?.data_base64 ?? "", "base64").length, 65_536);
  const second = artifactImageChunk({ ...input, image, offset: 65_536 });
  assert.equal(Buffer.from(second?.data_base64 ?? "", "base64").length, bytes.length - 65_536);
  Buffer.from("RIFF").copy(bytes); Buffer.from("WEBP").copy(bytes, 8);
  writeFileSync(path, bytes);
  assert.equal(artifactImageChunk({ ...input, image })?.mime_type, "image/webp");
  assert.equal(artifactImageChunk({ ...input, image, taskId: "other" }), undefined);
  assert.equal(artifactImageChunk({ ...input, image, projectId: "other" }), undefined);
  assert.equal(artifactImageChunk({ ...input, image, provider: "codex" }), undefined);
  assert.equal(artifactImageChunk({ ...input, image, storePath: join(root, "missing") }), undefined);
  assert.equal(artifactImageChunk({ ...input, image: { ...image, path: workspace } }), undefined);
  mkdirSync(join(workspace, "directory.png"));
  assert.equal(artifactImageChunk({ ...input, image: { ...image, path: "directory.png" } }), undefined);
});

test("full messages remain bounded while tool summaries retain their compact limit", () => {
  const out: ActivityEntry[] = [];
  for (const kind of ["message", "tool", "status"] as const) {
    pushEntry({ out, seen: new Set(), sessionId: "s", kind, text: "x".repeat(20_000), createdAt: 1, ordinal: 0 });
  }
  assert.deepEqual(out.map((entry) => entry.text.length), [16_384, 700, 700]);
  assert.ok(out.every((entry) => entry.text.endsWith("…")));
});

test("historical PNG links show a uniquely converted sibling image", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-image-converted-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storePath = join(root, "mesh.json");
  writeFileSync(storePath, JSON.stringify({ version: 1,
    projects: [{ projectId: "p", name: "Test", canonicalRepositoryId: "repo", createdAt: 1 }],
    tasks: [{ taskId: "t", projectId: "p", title: "Test", goal: "Test", state: "working", createdAt: 1, updatedAt: 2 }],
    executions: [{ taskId: "t", sessionId: "s", provider: "codex", computerId: "c", workspace: root, startedAt: 1 }],
  }));
  const input = { projectId: "p", taskId: "t", sessionId: "s", provider: "codex", offset: 0, storePath,
    image: artifactImages({ id: "entry", kind: "final", text: "[badge](badge.png)" })[0]! };
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0]);
  writeFileSync(join(root, "badge.jpg"), jpeg);
  assert.equal(artifactImageChunk(input)?.mime_type, "image/jpeg");
  writeFileSync(join(root, "badge.webp"), Buffer.from("RIFFabcdWEBP"));
  assert.equal(artifactImageChunk(input), undefined, "ambiguous conversions must not select a different artifact");
  writeFileSync(join(root, "badge.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
  assert.equal(artifactImageChunk(input)?.mime_type, "image/png", "the original exact path wins");
});
