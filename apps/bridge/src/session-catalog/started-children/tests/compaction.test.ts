import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo, SessionsStatus } from "../../../../../../packages/protocol/schema";
import { SessionInfo as SessionSchema } from "../../../../../../packages/protocol/schema";
import { compactStartedChildren } from "..";
import { publishCatalogHeads } from "../../publish-heads";
import type { RelayClient } from "../../../../../../packages/core/relay-client";

// Nothing written down: the counts here come from the rows alone.
process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-compaction-"));
const now = 1_800_000_000_000;
const parent: SessionInfo = { sessionId: "parent-chat-0001", agent: "claude", title: "Illustrate the lessons", state: "working",
  startedAt: now - 3_600_000, lastActivityAt: now, tokensSession: 0, tokensLastTurn: 0 };
/** 600 short image runs: 540 stopped by the usage limit, 60 saved a picture, 4 still running. */
const children: SessionInfo[] = Array.from({ length: 604 }, (_, index) => ({
  sessionId: `image-run-${String(index).padStart(4, "0")}`, agent: "codex", cwd: "/tmp/lessonart",
  title: `Draw lesson picture ${index} as a wide landscape, save the file, print the path, stop.`,
  summary: index < 540 ? "Codex stopped: You’ve hit your usage limit." : "Picture saved: lesson.png",
  state: index >= 600 ? "working" : "idle", startedAt: now - 600_000 + index * 900, lastActivityAt: now - 600_000 + index * 900 + 3_000,
  tokensSession: 0, tokensLastTurn: 0, startedBy: { agent: "claude", sessionId: parent.sessionId },
  ...(index < 540 ? { stopped: { reason: "usage_limit", message: "You’ve hit your usage limit.", at: now - 1 },
    usageLimit: { resetsAt: now + 3_600_000, autoContinue: false } } : {}),
  ...(index >= 540 && index < 600 ? { images: [{ id: `helper-image:${"a".repeat(24)}:${"b".repeat(24)}`, name: "lesson.png",
    markdown: "/tmp/lessonart/lesson.png" }] } : {}),
}));
const others: SessionInfo[] = Array.from({ length: 30 }, (_, index) => ({ sessionId: `interactive-${index}-chat`, agent: "codex",
  title: "Fix the build", state: "idle", startedAt: now - 7_200_000, lastActivityAt: now - 7_200_000 + index, tokensSession: 0, tokensLastTurn: 0 }));

test("hundreds of finished runs one chat started become a few rows and a count on that chat", () => {
  const before = [parent, ...children, ...others];
  const after = compactStartedChildren(before);
  const bytes = (rows: SessionInfo[]) => Buffer.byteLength(JSON.stringify(rows));
  // Before: 635 rows, about 0.3 MB per catalog, sealed once for every paired phone on each refresh.
  assert.equal(before.length, 635);
  assert.ok(bytes(before) > 250_000);
  // After: the parent, its 4 running and 3 newest finished runs, and every other chat.
  assert.equal(after.length, 1 + 4 + 3 + 30);
  assert.ok(bytes(after) < 20_000, `${bytes(after)} bytes`);
  const summary = after.find((row) => row.sessionId === parent.sessionId)!.startedChildren;
  assert.deepEqual(summary, { finished: 600, stopped: 540, limited: 540, pictures: 60, lastAt: children[599]!.lastActivityAt });
  assert.ok(SessionSchema.parse(after[0]).startedChildren);
  assert.ok(after.some((row) => row.sessionId === "image-run-0599") && !after.some((row) => row.sessionId === "image-run-0001"));
  // A child whose parent is not listed stays a row.
  assert.equal(compactStartedChildren(children).length, children.length);
});

test("finished runs another chat started are not refreshed as bulk transcript heads", () => {
  const published: string[] = [];
  const client = { supportsRetainedState: true, isConnected: true } as unknown as RelayClient;
  const status = { type: "sessions.status", machine: "mac", sessions: [parent, ...children.slice(-40)], generatedAt: now } as SessionsStatus;
  publishCatalogHeads(client, status, new Set(["image-run-0570"]), async (_client, sessionId) => { published.push(sessionId); });
  return new Promise<void>((resolve) => setTimeout(() => {
    // Before: 32 heads a pass, each a key grant and a transcript for every paired phone; after: the
    // running ones, the parent and the one a phone has open.
    assert.deepEqual(published.sort(), ["image-run-0570", "image-run-0600", "image-run-0601", "image-run-0602", "image-run-0603",
      "parent-chat-0001"]);
    resolve();
  }, 50));
});
