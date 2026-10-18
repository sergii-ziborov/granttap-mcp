import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cursorExecution, cursorExecutionRootSessionId, saveCursorExecution } from "../index";

test("Cursor execution aliases preserve Task/workspace identity across reopening and cannot be rebound", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-cursor-executions-")), before = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (before === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = before;
    rmSync(root, { recursive: true, force: true }); });
  const value = { sessionId: "ide-task", nativeSessionId: "native-execution", cwd: root };
  assert.equal(cursorExecution(value.sessionId, root), undefined);
  saveCursorExecution(value);
  assert.deepEqual(cursorExecution(value.sessionId, root), value);
  assert.equal(cursorExecutionRootSessionId(value.nativeSessionId), value.sessionId);
  assert.equal(cursorExecutionRootSessionId("foreign"), undefined);
  assert.equal(cursorExecution(value.sessionId, join(root, "other")), undefined);
  assert.throws(() => saveCursorExecution({ ...value, nativeSessionId: "new-execution" }), /already has/);
  assert.throws(() => saveCursorExecution({ ...value, sessionId: "other-task" }), /another Task/);
  const directory = join(root, "cursor-executions", "tasks"), file = join(directory, readdirSync(directory)[0]!);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), ["cwd", "nativeSessionId", "sessionId"]);
  unlinkSync(file);
  assert.throws(() => cursorExecutionRootSessionId(value.nativeSessionId), /no matching Task/);
});
