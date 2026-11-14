import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { helperRunLink, helperRunLinksPath, rememberHelperRunLinks, type HelperRunLink } from "../links";

const DAY = 86_400_000;

function isolatedConfig(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "granttap-helper-links-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function link(folder: string, parentSessionId: string, capturedAt = Date.now()): HelperRunLink {
  return { folder, kind: "image-generation", parentAgent: "claude", parentSessionId, capturedAt };
}

test("a captured parent is written down and read back after the run and the process are gone", (t) => {
  isolatedConfig(t);
  assert.equal(helperRunLink("/tmp/hw-image-aaaa1111"), undefined);
  assert.equal(rememberHelperRunLinks([link("/tmp/hw-image-aaaa1111", "parent-chat-1")]), 1);
  assert.equal(helperRunLink("/tmp/hw-image-aaaa1111")?.parentSessionId, "parent-chat-1");
  assert.equal(helperRunLink("/private/tmp/hw-image-aaaa1111")?.parentSessionId, "parent-chat-1",
    "either spelling of the folder finds the link");
  const stored = JSON.parse(readFileSync(helperRunLinksPath(), "utf8"));
  assert.deepEqual(stored.links.map((item: HelperRunLink) => [item.folder, item.parentAgent, item.parentSessionId]),
    [["/tmp/hw-image-aaaa1111", "claude", "parent-chat-1"]]);
  if (process.platform !== "win32") assert.equal(statSync(helperRunLinksPath()).mode & 0o777, 0o600);
});

test("the first capture of a run stands, and a repeated one writes nothing", (t) => {
  isolatedConfig(t);
  rememberHelperRunLinks([link("/tmp/hw-image-bbbb2222", "first-parent")]);
  const written = statSync(helperRunLinksPath()).mtimeMs;
  assert.equal(rememberHelperRunLinks([link("/tmp/hw-image-bbbb2222", "second-parent")]), 0);
  assert.equal(helperRunLink("/tmp/hw-image-bbbb2222")?.parentSessionId, "first-parent");
  assert.equal(statSync(helperRunLinksPath()).mtimeMs, written);
});

test("links older than the chat history kept on the computer are dropped, and the newest are kept", (t) => {
  isolatedConfig(t);
  const now = Date.now();
  rememberHelperRunLinks([link("/tmp/hw-image-oldd0000", "old-parent", now - 200 * DAY)], now - 200 * DAY);
  rememberHelperRunLinks(Array.from({ length: 2_010 }, (_item, index) =>
    link(`/tmp/hw-image-n${String(index).padStart(7, "0")}`, `parent-${index}`, now - (2_010 - index))), now);
  assert.equal(helperRunLink("/tmp/hw-image-oldd0000"), undefined);
  assert.equal(helperRunLink("/tmp/hw-image-n0000000"), undefined, "the oldest beyond the bound are dropped");
  assert.equal(helperRunLink("/tmp/hw-image-n0002009")?.parentSessionId, "parent-2009");
  assert.equal(JSON.parse(readFileSync(helperRunLinksPath(), "utf8")).links.length, 2_000);
});

test("an unreadable or foreign file is no links, and a malformed entry is skipped", (t) => {
  isolatedConfig(t);
  writeFileSync(helperRunLinksPath(), "{not json");
  assert.equal(helperRunLink("/tmp/hw-image-cccc3333"), undefined);
  writeFileSync(helperRunLinksPath(), JSON.stringify({ version: 1, links: [
    { folder: "/tmp/hw-image-cccc3333", kind: "image-generation", parentAgent: "claude", parentSessionId: "ok-parent-1", capturedAt: Date.now() },
    { folder: "/tmp/hw-image-dddd4444", kind: "image-generation", parentAgent: "claude", parentSessionId: 7, capturedAt: Date.now() },
    { folder: "/Users/someone/project", kind: "image-generation", parentAgent: "claude", parentSessionId: "not-a-helper-folder", capturedAt: Date.now() },
    "nonsense",
  ] }));
  // The cache is keyed by the file's size and time; a rewrite within one clock tick is still seen.
  assert.equal(helperRunLink("/tmp/hw-image-cccc3333")?.parentSessionId, "ok-parent-1");
  assert.equal(helperRunLink("/tmp/hw-image-dddd4444"), undefined);
  assert.equal(helperRunLink("/Users/someone/project"), undefined);
  assert.equal(rememberHelperRunLinks([link("/tmp/hw-image-eeee5555", "next-parent")]), 1);
  assert.equal(helperRunLink("/tmp/hw-image-cccc3333")?.parentSessionId, "ok-parent-1", "what was readable is kept");
});
