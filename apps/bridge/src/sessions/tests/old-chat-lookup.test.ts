import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deliveryTarget, findSessionCooperatively, scanSessionsCooperatively } from "../catalog";

test("a message to a chat that has been idle for days finds it while its transcript is on the computer", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-old-chat-"));
  const prior = process.env.GRANTTAP_CLAUDE_PROJECTS_DIR;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.GRANTTAP_CLAUDE_PROJECTS_DIR; else process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  });
  const day = 86_400_000, now = Date.now();
  const write = (id: string, at: number) => writeFileSync(join(root, `${id}.jsonl`), [
    { type: "user", sessionId: id, timestamp: new Date(at).toISOString(), message: { role: "user", content: "Synthetic question" } },
    { type: "assistant", sessionId: id, timestamp: new Date(at + 1_000).toISOString(),
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Synthetic answer" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  write("recent-chat", now - 60_000);
  write("eight-days-old-chat", now - 8 * day);

  const live = (await scanSessionsCooperatively()).sessions;
  assert.deepEqual(live.map(session => session.sessionId), ["recent-chat"], "only a recent chat is live");
  assert.equal(await findSessionCooperatively("eight-days-old-chat", false), undefined, "a live-only lookup misses it");
  const target = await deliveryTarget(undefined, "eight-days-old-chat");
  assert.equal(target?.sessionId, "eight-days-old-chat",
    "the message is delivered, not refused as no longer available on the computer");
  const published = { ...target!, title: "Published" };
  assert.equal((await deliveryTarget(published, "eight-days-old-chat"))?.title, "Published",
    "the catalog this monitor published is used first, without a scan");
  assert.equal(await deliveryTarget(undefined, "never-existed"), undefined);
});
