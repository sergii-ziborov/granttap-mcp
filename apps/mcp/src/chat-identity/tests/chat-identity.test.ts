import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chatBinding, openCodexThread, type ChatProcessProbe } from "..";
import {
  hostOf, nearestHost, parseColumn, parseOpenFiles, parseParents, readAncestry, readOpenFiles, type ProcessFacts,
} from "../processes";

const thread = "019a7c1e-aaaa-7bbb-8ccc-0123456789ab";
const other = "019a7c1e-bbbb-7bbb-8ccc-0123456789ab";
const rollout = (id: string) => `/Users/someone/.codex/sessions/2026/11/17/rollout-2026-11-17T02-14-08-${id}.jsonl`;
const proc = (executable: string, args = executable, pid = 7): ProcessFacts => ({ pid, executable, args });
const probe = (host?: ReturnType<ChatProcessProbe["host"]>, files: string[] = []): ChatProcessProbe =>
  ({ host: () => host, openFiles: () => files });

test("each coding agent is recognised by its own executable, never by a launcher between it and the server", () => {
  const same = (path: string) => path;
  assert.equal(hostOf(proc("/Users/someone/.local/bin/claude"), same), "claude");
  assert.equal(hostOf(proc("/Users/someone/Library/Application Support/Claude/claude-code/2.1.325/claude.app/Contents/MacOS/claude"), same), "claude");
  assert.equal(hostOf(proc("node", "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js -p"), same), "claude");
  assert.equal(hostOf(proc("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"), same), "codex");
  assert.equal(hostOf(proc("C:\\Tools\\codex.exe"), same), "codex");
  assert.equal(hostOf(proc("/Users/someone/.grok/downloads/grok-1.0.77-macos-aarch64"), same), "grok");
  assert.equal(hostOf(proc("/Users/someone/.local/bin/agent"), () => "/Users/someone/.grok/downloads/grok-1.0.77"), "grok");
  assert.equal(hostOf(proc("/Users/someone/.local/bin/agent"), () => "/Users/someone/.grok/bin/agent"), "grok");
  assert.equal(hostOf(proc("/Users/someone/.local/bin/agent"), () => "/Users/someone/.local/share/cursor-agent/versions/1/agent"), "cursor");
  assert.equal(hostOf(proc("/Users/someone/.local/bin/cursor-agent"), same), "cursor");
  assert.equal(hostOf(proc("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)"), same), "cursor");
  for (const launcher of ["/Applications/Claude.app/Contents/MacOS/Claude", "/Applications/Claude.app/Contents/Helpers/disclaimer",
    "/bin/zsh", "node", "/usr/local/bin/npm", ""]) {
    assert.equal(hostOf(proc(launcher, `${launcher} granttap mcp`), same), undefined, launcher);
  }
  assert.equal(hostOf(proc("/nonexistent/claude")), "claude", "a path that cannot be resolved is read as written");
  const chain = [proc("node", "node granttap mcp", 30), proc("/usr/local/bin/grok", "grok", 20), proc("/usr/local/bin/claude", "claude", 10)];
  assert.deepEqual(nearestHost(chain), { host: "grok", pid: 20 }, "a Grok run a Claude chat started owns its own servers");
  assert.equal(nearestHost([proc("node", "node x", 3)]), undefined);
});

test("the process listings are read by pid, with paths that contain spaces kept whole", () => {
  assert.deepEqual([...parseColumn(" 101 /Applications/Cursor.app/Contents/MacOS/Cursor Helper (Plugin)\n  7 /bin/zsh\nnot a row\n")],
    [[101, "/Applications/Cursor.app/Contents/MacOS/Cursor Helper (Plugin)"], [7, "/bin/zsh"]]);
  assert.deepEqual([...parseParents("  1     0\n 55   1\nbad line\n")], [[1, 0], [55, 1]]);
  assert.deepEqual(parseOpenFiles("p42\nfcwd\nn/Users/someone/repo\nf3\nn/tmp/x.jsonl\nf4\nnpipe\n"),
    ["/Users/someone/repo", "/tmp/x.jsonl"]);
});

test("this process's own ancestry and open files can be read where the platform shows them", { skip: !["darwin", "linux"].includes(process.platform) }, () => {
  const chain = readAncestry(process.pid);
  assert.equal(chain[0]?.pid, process.pid);
  assert.match(chain[0]!.executable + chain[0]!.args, /node/);
  assert.ok(chain.length <= 6, "the walk stops after the launchers a host can put between itself and a server");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "granttap-open-files-"))), path = join(dir, "held.jsonl");
  const fd = openSync(path, "w");
  try { assert.ok(readOpenFiles(process.pid).includes(path)); }
  finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(readAncestry(2 ** 30), [], "a process that does not exist has no ancestry");
  assert.deepEqual(readOpenFiles(2 ** 30), []);
});

test("Claude Code and Grok Build name their chat in the environment, and only the nearest host's variable counts", () => {
  const env = { CLAUDE_CODE_SESSION_ID: "claude-chat-0001", GROK_SESSION_ID: "grok-chat-0001", CODEX_THREAD_ID: thread };
  assert.deepEqual(chatBinding(env, probe({ host: "claude", pid: 1 })),
    { sessionId: "claude-chat-0001", provider: "claude", source: "environment", identity: "bound" });
  assert.deepEqual(chatBinding(env, probe({ host: "grok", pid: 1 })),
    { sessionId: "grok-chat-0001", provider: "grok", source: "environment", identity: "bound" });
  assert.deepEqual(chatBinding({ CLAUDE_CODE_SESSION_ID: "claude-chat-0001" }, probe({ host: "grok", pid: 1 })),
    { provider: "grok", identity: "unbound" }, "a Grok run started from a Claude shell is not that Claude chat");
  assert.deepEqual(chatBinding({ CLAUDE_CODE_SESSION_ID: "claude-chat-0001" }, probe({ host: "cursor", pid: 1 })),
    { provider: "cursor", identity: "unbound" }, "Cursor's server is shared by its chats, so none is named");
  assert.deepEqual(chatBinding({ CLAUDE_CODE_SESSION_ID: "short" }, probe({ host: "claude", pid: 1 })),
    { provider: "claude", identity: "unbound" });
});

test("a Codex chat is named by the one rollout its Codex process holds open, never by a guess", () => {
  const codex = { host: "codex" as const, pid: 9 };
  assert.deepEqual(chatBinding({ CLAUDE_CODE_SESSION_ID: "claude-chat-0001" }, probe(codex, [rollout(thread), "/Users/someone/repo/file.ts"])),
    { sessionId: thread, provider: "codex", source: "transcript", identity: "bound" },
    "Codex starts its servers with a bare environment; an inherited Claude id is not its chat");
  assert.deepEqual(chatBinding({}, probe(codex, [rollout(thread), rollout(other)])), { provider: "codex", identity: "unbound" },
    "the desktop app or a chat with live subagents holds several, and none is picked");
  assert.deepEqual(chatBinding({}, probe(codex, ["/Users/someone/.codex/history.jsonl"])), { provider: "codex", identity: "unbound" });
  assert.deepEqual(chatBinding({ CODEX_THREAD_ID: thread }, probe(codex, [rollout(other)])),
    { sessionId: thread, provider: "codex", source: "environment", identity: "bound" }, "a variable Codex sets wins");
  const failing: ChatProcessProbe = { host: () => codex, openFiles: () => { throw new Error("lsof failed"); } };
  assert.deepEqual(chatBinding({}, failing), { provider: "codex", identity: "unbound" });
  assert.equal(openCodexThread([rollout(thread), rollout(thread.toUpperCase())]), thread, "one rollout open twice is one chat");
  assert.equal(openCodexThread([`/tmp/rollout-x-${thread}.jsonl`]), undefined, "only a rollout in a sessions folder counts");
});

test("where no host can be seen, one provider variable names the chat and two name none", () => {
  const unseen = probe(undefined);
  assert.deepEqual(chatBinding({ CLAUDE_CODE_SESSION_ID: "claude-chat-0001" }, unseen),
    { provider: "claude", sessionId: "claude-chat-0001", source: "environment", identity: "bound" });
  assert.deepEqual(chatBinding({ GROK_SESSION_ID: "grok-chat-0001" }, unseen),
    { provider: "grok", sessionId: "grok-chat-0001", source: "environment", identity: "bound" });
  assert.deepEqual(chatBinding({ CLAUDE_CODE_SESSION_ID: "claude-chat-0001", GROK_SESSION_ID: "grok-chat-0001" }, unseen),
    { identity: "unbound" });
  assert.deepEqual(chatBinding({}, unseen), { identity: "unbound" });
  const broken: ChatProcessProbe = { host: () => { throw new Error("ps failed"); }, openFiles: () => [] };
  assert.equal(chatBinding({ CLAUDE_CODE_SESSION_ID: "claude-chat-0001" }, broken).sessionId, "claude-chat-0001");
  assert.deepEqual(chatBinding({}, undefined), { identity: "unbound" }, "a test process has no host above it");
});
