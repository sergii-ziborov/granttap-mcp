import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionInfo } from "../packages/protocol/schema";
import { aggregateChildThreads } from "../apps/bridge/src/sessions/child-threads";
import {
  claudeActivity,
  claudeCapabilityUsage,
  scanClaude,
} from "../apps/bridge/src/sessions/claude";
import {
  codexActivity,
  codexCapabilityUsage,
  scanCodex,
} from "../apps/bridge/src/sessions/codex";
import {
  cursorActivity,
  cursorRootSessionId,
  scanCursor,
} from "../apps/bridge/src/sessions/cursor";

function setEnv(t: test.TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  });
}

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test("child metadata is bounded while parent token accounting includes every child", () => {
  const now = Date.now();
  const parent = SessionInfo.parse({
    sessionId: "root",
    agent: "codex",
    state: "idle",
    startedAt: now,
    lastActivityAt: now,
    tokensSession: 5,
    tokensLastTurn: 5,
  });
  const aggregated = aggregateChildThreads(
    parent,
    Array.from({ length: 40 }, (_, index) => ({
      threadId: `child-${index}`,
      parentThreadId: "root",
      title: `Child ${index}`,
      depth: 1,
      state: "idle" as const,
      startedAt: now + index,
      lastActivityAt: now + index,
      tokensSession: 10,
      tokensLastTurn: 2,
    })),
  );
  assert.equal(aggregated.childThreads?.length, 32);
  assert.equal(aggregated.tokensSession, 405, "bounded navigation must not truncate spend");
  assert.doesNotThrow(() => SessionInfo.parse(aggregated));
});

test("Cursor policy scope resolves nested parents and fails closed on ambiguity or cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-policy-scope-"));
  const db = join(root, "state.vscdb");
  execFileSync("sqlite3", [db, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);"]);
  const insert = (id: string, children: string[]): void => {
    const payload = JSON.stringify({ composerId: id, subagentComposerIds: children })
      .replace(/'/g, "''");
    execFileSync("sqlite3", [db,
      `INSERT INTO cursorDiskKV(key,value) VALUES('composerData:${id}', '${payload}');`,
    ]);
  };
  insert("root", ["child", "ambiguous"]);
  insert("child", ["grandchild"]);
  insert("other-root", ["ambiguous"]);
  insert("cycle-a", ["cycle-b"]);
  insert("cycle-b", ["cycle-a"]);

  assert.equal(cursorRootSessionId("grandchild", db), "root");
  assert.equal(cursorRootSessionId("ambiguous", db), "ambiguous");
  assert.equal(cursorRootSessionId("cycle-a", db), "cycle-a");
  assert.equal(cursorRootSessionId("unknown", db), "unknown");
  assert.equal(cursorRootSessionId(" ", db), null);
});
