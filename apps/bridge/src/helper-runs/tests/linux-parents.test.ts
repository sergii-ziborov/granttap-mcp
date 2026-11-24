import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLinuxProcessParents } from "../capture";

/** A `/proc` entry: its owner line and its NUL-separated environment. */
function proc(root: string, pid: number, uid: number, environment: string[]): void {
  mkdirSync(join(root, String(pid)), { recursive: true });
  writeFileSync(join(root, String(pid), "status"), `Name:\tcodex\nUmask:\t0022\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  writeFileSync(join(root, String(pid), "environ"), environment.join("\0") + "\0");
}

test("on Linux the chat that started a run is read from the run's own /proc environment, for this person's processes only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-proc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  proc(root, 41, 1000, ["HOME=/home/someone", "CLAUDE_CODE_SESSION_ID=claude-chat-0001", "PATH=/usr/bin"]);
  proc(root, 42, 1000, ["CODEX_THREAD_ID=codex-thread-0001", "TERM=xterm"]);
  proc(root, 43, 1000, ["SPACED=a CLAUDE_CODE_SESSION_ID=not-a-variable-0001", "PATH=/bin"]);
  proc(root, 44, 0, ["CLAUDE_CODE_SESSION_ID=another-person-0001"]);
  proc(root, 45, 1000, ["CLAUDE_CODE_SESSION_ID=bad"]);

  const parents = readLinuxProcessParents([41, 42, 43, 44, 45, 46], 1000, root);
  assert.deepEqual([...parents], [
    [41, { agent: "claude", sessionId: "claude-chat-0001" }],
    [42, { agent: "codex", sessionId: "codex-thread-0001" }],
  ], "a value that only mentions a variable, another person's process, a malformed id and a gone process name no chat");
  assert.deepEqual([...readLinuxProcessParents([44], undefined, root)],
    [[44, { agent: "claude", sessionId: "another-person-0001" }]], "without a known uid the owner is not filtered");
});
