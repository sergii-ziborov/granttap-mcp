import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cursorRootSessionId,
  loadComposerCatalog,
  loadSidebarTitles,
} from "../apps/bridge/src/sessions/cursor/catalog";

function sqlite(db: string, statement: string): void {
  execFileSync("sqlite3", [db, statement]);
}

function insertComposer(db: string, id: string, value: unknown): void {
  sqlite(db, `INSERT INTO cursorDiskKV VALUES('composerData:${id}','${
    JSON.stringify(value).replace(/'/g, "''")
  }');`);
}

test("Cursor sidebar titles are cached per database fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-sidebar-"));
  const db = join(root, "conversation-search.db");
  sqlite(db, "CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT);");
  sqlite(db, "INSERT INTO conversations VALUES('composer-a','Review the relay');");
  sqlite(db, "INSERT INTO conversations VALUES('composer-b','   ');");
  sqlite(db, "INSERT INTO conversations VALUES('composer-c',NULL);");

  const first = loadSidebarTitles(db);
  assert.equal(first.get("composer-a"), "Review the relay");
  assert.equal(first.has("composer-b"), false);
  assert.equal(first.has("composer-c"), false);
  assert.equal(loadSidebarTitles(db), first, "an unchanged database reuses the cached titles");

  assert.equal(loadSidebarTitles(join(root, "missing.db")).size, 0);
  const broken = join(root, "broken.db");
  await writeFile(broken, "not a sqlite database");
  assert.equal(loadSidebarTitles(broken).size, 0);
});

test("Cursor composer rows normalize subagents, workspace URIs, and unreadable databases", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-composer-"));
  const db = join(root, "state.vscdb");
  sqlite(db, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
  const now = Date.now();
  insertComposer(db, "parent", {
    composerId: "parent", name: "  Parent composer  ", lastUpdatedAt: now, createdAt: now - 2_000,
    status: "completed", subagentComposerIds: JSON.stringify(["child", 7]),
    workspaceIdentifier: { uri: { path: "file:///repo/app" } },
    contextTokensUsed: 4_200, modelConfig: { modelName: "composer-1" },
  });
  insertComposer(db, "child", {
    composerId: "child", name: "Child composer", lastUpdatedAt: now, createdAt: now - 1_000,
    subagentComposerIds: "{not json", isDraft: 1, isArchived: true,
    workspaceIdentifier: { uri: { fsPath: "/repo/app" } },
  });
  insertComposer(db, "plain", {
    composerId: "plain", name: "Plain composer", lastUpdatedAt: now, createdAt: now,
    subagentComposerIds: [],
  });

  const rows = loadComposerCatalog(db);
  const parent = rows.find((row) => row.id === "parent");
  const child = rows.find((row) => row.id === "child");
  assert.equal(parent?.name, "Parent composer");
  assert.equal(parent?.cwd, "/repo/app");
  assert.deepEqual(parent?.subagentIds, ["child"]);
  assert.equal(parent?.contextTokensUsed, 4_200);
  assert.equal(parent?.model, "composer-1");
  assert.deepEqual(child?.subagentIds, []);
  assert.equal(child?.isDraft, true);
  assert.equal(child?.isArchived, true);
  assert.equal(loadComposerCatalog(db), rows, "a warm catalog is reused inside its cache window");

  assert.equal(cursorRootSessionId("child", db), "parent");
  assert.equal(cursorRootSessionId("parent", db), "parent");
  assert.equal(cursorRootSessionId("   ", db), null);
  assert.equal(cursorRootSessionId(undefined, db), null);
  assert.equal(cursorRootSessionId("x".repeat(257), db), null);

  const broken = join(root, "broken.vscdb");
  await writeFile(broken, "not a sqlite database");
  assert.deepEqual(loadComposerCatalog(broken), []);
  assert.deepEqual(loadComposerCatalog(join(root, "missing.vscdb")), []);
});
