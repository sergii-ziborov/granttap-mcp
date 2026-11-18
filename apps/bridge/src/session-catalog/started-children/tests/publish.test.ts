import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RelayClient } from "../../../../../../packages/core/relay-client";
import { Payload, SessionsChildren, type SessionInfo, type SessionsStatus } from "../../../../../../packages/protocol/schema";
import { rememberStartedLinks } from "../../../started-by/links";
import { countStartedRuns, MAX_PUBLISHED_CHILDREN, publishStartedChildren, startedChildIds } from "..";

const PARENT = { agent: "claude" as const, sessionId: "38034755-03a1-429d-8db6-2aa351e64a0b" };
const now = Date.now();
const id = (index: number) => `019a8c00-0000-7000-8000-${String(index).padStart(12, "0")}`;

function isolated(t: TestContext): void {
  const config = mkdtempSync(join(tmpdir(), "granttap-children-publish-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = config;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(config, { recursive: true, force: true });
  });
}

const parentRow: SessionInfo = { sessionId: PARENT.sessionId, agent: "claude", title: "3 articles about a job search", state: "idle",
  startedAt: now - 20 * 3_600_000, lastActivityAt: now - 19 * 3_600_000, tokensSession: 0, tokensLastTurn: 0,
  startedChildren: { finished: 890, stopped: 430, limited: 428, pictures: 300, lastAt: now - 17 * 3_600_000 } };
const status = (rows: SessionInfo[]): SessionsStatus => ({ type: "sessions.status", machine: "Mac", sessions: [], history: rows,
  tokensRecent: 0, tokenWindowHours: 12, generatedAt: now } as SessionsStatus);

function client() {
  const sent: Array<{ payload: unknown; to: string; options: unknown }> = [];
  return { sent, relay: { send: async (payload: unknown, to: string, options: unknown) => { sent.push({ payload, to, options }); } } as
    unknown as RelayClient };
}

test("a listed chat's runs reach the phone as ids once, then only when they change or a quarter hour has passed", async (t) => {
  isolated(t);
  // 890 finished runs written down, and one still working that only the link store knows.
  countStartedRuns(Array.from({ length: 890 }, (_, index) => ({ parent: PARENT,
    run: { sessionId: id(index), end: index < 428 ? "limit" as const : "answered" as const, picture: index >= 590, at: now - 3_600_000 + index } })), now);
  rememberStartedLinks([{ agent: "codex", sessionId: id(5_000), parent: PARENT, source: "process", at: now }], [], now);
  const { sent, relay } = client();
  assert.equal(await publishStartedChildren(relay, status([parentRow, { ...parentRow, sessionId: "019a8c00-0000-7000-8000-nochildren0",
    agent: "codex", startedChildren: undefined }]), now), 1);
  const message = SessionsChildren.parse(sent[0]!.payload);
  assert.equal(sent[0]!.to, "phone");
  assert.deepEqual(sent[0]!.options, { ttlMs: 12 * 60_000, reliable: false });
  assert.ok(Payload.safeParse(message).success);
  assert.deepEqual(message.parent, PARENT);
  assert.equal(message.total, 891);
  assert.deepEqual(message.children.slice(0, 2), [id(5_000), id(889)], "newest first, a working run among them");
  const bytes = Buffer.byteLength(JSON.stringify(message));
  assert.ok(bytes < 40_000, `${bytes} bytes for 891 runs`);

  assert.equal(await publishStartedChildren(relay, status([parentRow]), now + 5 * 60_000), 0, "nothing new: nothing sent");
  countStartedRuns([{ parent: PARENT, run: { sessionId: id(900), end: "answered", picture: true, at: now + 1 } }], now);
  assert.equal(await publishStartedChildren(relay, status([parentRow]), now + 5 * 60_000 + 30_000), 1, "a new run: sent again");
  assert.equal(await publishStartedChildren(relay, status([parentRow]), now + 5 * 60_000 + 40_000), 0);
  assert.equal(await publishStartedChildren(relay, status([parentRow]), now + 21 * 60_000), 1, "a phone that was away hears it again");
  assert.equal(sent.length, 3);
});

test("a parent with more runs than one message holds sends the newest and says how many there are", (t) => {
  isolated(t);
  countStartedRuns(Array.from({ length: MAX_PUBLISHED_CHILDREN + 10 }, (_, index) => ({ parent: PARENT,
    run: { sessionId: id(index), end: "answered" as const, picture: false, at: now - 100_000 + index } })), now);
  const { ids, total } = startedChildIds(PARENT);
  assert.equal(ids.length, MAX_PUBLISHED_CHILDREN);
  assert.equal(total, MAX_PUBLISHED_CHILDREN + 10);
  assert.equal(ids[0], id(MAX_PUBLISHED_CHILDREN + 9));
  assert.ok(SessionsChildren.safeParse({ type: "sessions.children", parent: PARENT, children: ids, total, generatedAt: now }).success);
  assert.equal(SessionsChildren.safeParse({ type: "sessions.children", parent: PARENT, children: [...ids, id(1)], total, generatedAt: now })
    .success, false, "at most 4,000 ids");
  assert.equal(SessionsChildren.safeParse({ type: "sessions.children", parent: PARENT, children: ["bad id!"], total: 1, generatedAt: now })
    .success, false);
});
