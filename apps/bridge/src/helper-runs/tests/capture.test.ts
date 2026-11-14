import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attributeByAncestry } from "../../machine-load/host/process-ownership";
import {
  createHelperRunCapture,
  helperRunProcesses,
  parseProcessDirectories,
  parseProcessParents,
  readProcessDirectories,
  readProcessParents,
  type HelperRunParent,
} from "../capture";
import type { HelperRunLink } from "../links";

const RUN = "/private/var/folders/ab/c0ffee123/T/hw-image-abcd1234";
const PARENT: HelperRunParent = { agent: "claude", sessionId: "parent-chat-1" };

function harness(input: {
  directories: Array<Record<number, string>>;
  parents?: Record<number, HelperRunParent>;
}) {
  const asked = { directories: [] as number[][], parents: [] as number[][] };
  const remembered: HelperRunLink[] = [];
  const capture = createHelperRunCapture({
    readers: {
      directories: async (pids) => {
        asked.directories.push([...pids]);
        const answer = input.directories[Math.min(asked.directories.length, input.directories.length) - 1] ?? {};
        return new Map(Object.entries(answer).map(([pid, path]) => [Number(pid), path]));
      },
      parents: async (pids) => {
        asked.parents.push([...pids]);
        return new Map(Object.entries(input.parents ?? {}).map(([pid, parent]) => [Number(pid), parent]));
      },
    },
    remember: (links) => { remembered.push(...links); return links.length; },
    now: () => 1_700_000_000_000,
  });
  return { capture, asked, remembered };
}

test("a helper run's live process names the chat that started it, and the link is written down", async () => {
  const { capture, asked, remembered } = harness({
    directories: [{ 10: "/Users/someone/dev/app", 20: RUN }], parents: { 20: PARENT },
  });
  const processes = [{ pid: 10, command: "claude --resume" }, { pid: 20, command: "grok --headless" }];
  assert.equal(await capture(processes), 1);
  assert.deepEqual(remembered, [{ folder: "/var/folders/ab/c0ffee123/T/hw-image-abcd1234",
    kind: "image-generation", parentAgent: "claude", parentSessionId: "parent-chat-1", capturedAt: 1_700_000_000_000 }]);
  assert.deepEqual(asked.parents, [[20]], "only the helper run's own process has its environment read");
  assert.equal(await capture(processes), 0);
  assert.deepEqual(asked.directories, [[10, 20]], "a process is looked at once, not on every sample");
});

test("when its environment does not name a chat, the provider process above it does", async () => {
  const { capture, remembered } = harness({ directories: [{ 20: RUN }] });
  assert.equal(await capture([{ pid: 20, command: "grok", ancestor: { agent: "codex", sessionId: "codex-thread-1" } }]), 1);
  assert.deepEqual(remembered.map((link) => [link.parentAgent, link.parentSessionId]), [["codex", "codex-thread-1"]]);
});

test("a helper run nobody can be named for is left without a link", async () => {
  const { capture, asked, remembered } = harness({ directories: [{ 20: RUN }] });
  assert.equal(await capture([{ pid: 20, command: "grok" }]), 0);
  assert.equal(await capture([{ pid: 20, command: "grok" }]), 0);
  assert.deepEqual(remembered, []);
  assert.deepEqual(asked.parents, [[20]], "an environment that names no chat is not read again");
});

test("a folder that cannot be read yet is asked for again, a few times and no more", async () => {
  const late = harness({ directories: [{}, { 20: RUN }], parents: { 20: PARENT } });
  assert.equal(await late.capture([{ pid: 20, command: "grok" }]), 0);
  assert.equal(await late.capture([{ pid: 20, command: "grok" }]), 1);
  const never = harness({ directories: [{}] });
  for (let sample = 0; sample < 6; sample += 1) await never.capture([{ pid: 30, command: "grok" }]);
  assert.equal(never.asked.directories.length, 3);
});

test("the generator's folder on the command line is used when the working folder is somewhere else", async () => {
  const named = harness({ directories: [{ 20: "/Users/someone/dev/app" }], parents: { 20: PARENT } });
  assert.equal(await named.capture([{ pid: 20, command: `grok -p draw --out ${RUN}/out.png` }]), 1);
  assert.equal(named.remembered[0]?.folder, "/var/folders/ab/c0ffee123/T/hw-image-abcd1234");
  const two = harness({ directories: [{ 20: "/Users/someone/dev/app" }], parents: { 20: PARENT } });
  assert.equal(await two.capture([{ pid: 20, command: `grok ${RUN}/a.png /tmp/hw-image-zzzz9999/b.png` }]), 0,
    "two different runs on one command line name neither");
  assert.deepEqual(two.asked.parents, []);
});

test("a process that has exited is forgotten, so its number can be looked at again", async () => {
  const { capture, asked } = harness({ directories: [{ 10: "/Users/someone/dev/app" }] });
  await capture([{ pid: 10, command: "claude" }]);
  await capture([]);
  await capture([{ pid: 10, command: "grok" }]);
  assert.equal(asked.directories.length, 2);
});

test("a failed reading is not an error and nothing is written", async () => {
  const remembered: HelperRunLink[] = [];
  const capture = createHelperRunCapture({
    readers: { directories: async () => { throw new Error("listing unavailable"); }, parents: async () => new Map() },
    remember: (links) => { remembered.push(...links); return links.length; },
  });
  assert.equal(await capture([{ pid: 20, command: "grok" }]), 0);
  assert.deepEqual(remembered, []);
});

test("the working folders are read from the listing by process", () => {
  assert.deepEqual([...parseProcessDirectories(`p101\nfcwd\nn/Users/someone/dev/app\np202\nfcwd\nn${RUN}\nnonsense\n`)],
    [[101, "/Users/someone/dev/app"], [202, RUN]]);
  assert.deepEqual([...parseProcessDirectories("")], []);
});

test("only the chat's id leaves a process's environment, and only for this person's processes", () => {
  const listing = [
    "  202   501 /usr/local/bin/grok --headless SECRET_TOKEN=do-not-keep CLAUDE_CODE_SESSION_ID=parent-chat-1 HOME=/Users/someone",
    "  303   501 /usr/local/bin/grok CODEX_THREAD_ID=019a7c1e-aaaa-7bbb-8ccc-0123456789ab PATH=/usr/bin",
    "  404     0 /usr/local/bin/grok CLAUDE_CODE_SESSION_ID=someone-elses-chat",
    "  505   501 /usr/local/bin/grok NOT_CLAUDE_CODE_SESSION_ID=parent-chat-9 CLAUDE_CODE_SESSION_ID=short",
    "garbage",
  ].join("\n");
  const parents = parseProcessParents(listing, 501);
  assert.deepEqual([...parents], [
    [202, { agent: "claude", sessionId: "parent-chat-1" }],
    [303, { agent: "codex", sessionId: "019a7c1e-aaaa-7bbb-8ccc-0123456789ab" }],
  ]);
  assert.doesNotMatch(JSON.stringify([...parents]), /SECRET|do-not-keep|HOME/);
});

test("a provider process started under a chat's own process inherits that chat as its ancestor", () => {
  const row = (pid: number, ppid: number, executable: string, command = executable) =>
    ({ pid, ppid, cpuPercent: 0, rssBytes: 0, executable, command });
  const rows = [
    row(100, 1, "/usr/local/bin/claude"),
    row(101, 100, "/bin/zsh", "/bin/zsh -c node generate.mjs"),
    row(102, 101, "/usr/local/bin/node", "node generate.mjs"),
    row(103, 102, "/Users/someone/.grok/bin/grok", "grok --headless"),
    row(200, 1, "/usr/local/bin/codex"),
    row(300, 1, "/Users/someone/.grok/bin/grok"),
    row(400, 1, "/bin/zsh"),
  ];
  const processes = helperRunProcesses(rows, attributeByAncestry(rows), new Map([[100, "parent-chat-1"]]));
  assert.deepEqual(processes, [
    { pid: 100, command: "/usr/local/bin/claude" },
    { pid: 103, command: "grok --headless", ancestor: { agent: "claude", sessionId: "parent-chat-1" } },
    { pid: 200, command: "/usr/local/bin/codex" },
    { pid: 300, command: "/Users/someone/.grok/bin/grok" },
  ]);
});

test("this computer's own tools report a live process's folder and the chat in its environment", async (t) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "hw-image-")));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: folder, stdio: "ignore",
    env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_SESSION_ID: "synthetic-parent-chat", OTHER_VALUE: "kept-private" },
  });
  t.after(() => { child.kill("SIGKILL"); rmSync(folder, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const pid = child.pid!;
  const directories = await readProcessDirectories([pid]);
  if (directories.size === 0) return t.skip("this host has no tool that reports a process's working folder");
  assert.equal(directories.get(pid), folder);
  assert.deepEqual((await readProcessParents([pid])).get(pid), { agent: "claude", sessionId: "synthetic-parent-chat" });
  assert.deepEqual([...await readProcessParents([])], []);
  const gone = 2_000_000_000;
  assert.equal((await readProcessDirectories([pid, gone])).get(pid), folder,
    "a process that has exited does not hide the ones still running");
  assert.deepEqual([...await readProcessDirectories([gone])], []);
  await assert.rejects(readProcessParents([gone]), /^Error: process environment unavailable$/,
    "a failed listing says only that it failed");
});
