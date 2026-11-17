import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ProcessRow } from "../../machine-load/host/process-sampler";
import { attributeByAncestry } from "../../machine-load/host/process-ownership";
import {
  createStartedRunCapture,
  parseChatVariables,
  runParent,
  startedRunProcesses,
  type ChatVariables,
  type StartedRunProcess,
} from "../capture";
import { startedByState, type StartedRun } from "../links";

const MONITOR = 500;
const CLAUDE_CHAT = "38034755-03a1-429d-8db6-2aa351e64a0b";
const SAMPLED = 1_800_000_000_000;

function configDir(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "granttap-started-capture-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const row = (pid: number, ppid: number, command: string, elapsedMs?: number): ProcessRow =>
  ({ pid, ppid, cpuPercent: 0, rssBytes: 0, command, ...(elapsedMs != null ? { elapsedMs } : {}) });

/** The monitor runs a phone chat; that chat's shell runs `codex exec`; a person's terminal runs two more. */
function listing(): ProcessRow[] {
  return [
    row(1, 0, "/sbin/launchd"),
    row(MONITOR, 1, "node /opt/granttap/bin/granttap-mcp.mjs internal serve"),
    row(600, MONITOR, `/Users/me/.local/bin/claude -p --resume ${CLAUDE_CHAT} --output-format stream-json`),
    row(601, 600, "/bin/zsh -c codex exec ..."),
    row(602, 601, "node /opt/homebrew/bin/codex exec Use your image_gen tool", 3_000),
    row(603, 602, "/opt/homebrew/lib/codex/codex-aarch64-apple-darwin exec Use your image_gen tool"),
    row(610, MONITOR, "/Users/me/.local/bin/claude -p new chat from the phone"),
    row(700, 1, "/bin/zsh -l"),
    row(701, 700, "/usr/local/bin/codex"),
    row(702, 700, "/usr/local/bin/claude -p one-off typed by a person", 1_000),
    row(703, 700, "/usr/local/bin/codex exec resume --last"),
  ];
}

function processes(rows = listing(), sessions = new Map<number, string>([[600, CLAUDE_CHAT]])): StartedRunProcess[] {
  return startedRunProcesses(rows, attributeByAncestry(rows), sessions, SAMPLED, MONITOR);
}

test("only headless runs a chat started are looked at; this monitor's own runs and people's sessions are not", () => {
  const found = processes();
  assert.deepEqual(found.map((item) => item.pid), [602, 702],
    "the phone runs (600, 610) are the monitor's own, 701 is interactive, 703 resumes a chat, 603 is 602's own binary");
  assert.deepEqual(found[0], { pid: 602, agent: "codex", startedAt: SAMPLED - 3_000,
    above: { agent: "claude", sessionId: CLAUDE_CHAT } });
  assert.deepEqual(found[1], { pid: 702, agent: "claude", startedAt: SAMPLED - 1_000 }, "a detached run has no provider above it");
});

test("the chat a run's environment names is the one of the provider directly above it", () => {
  const [codex, detached] = processes();
  assert.deepEqual(runParent(codex!, { claude: CLAUDE_CHAT }), { agent: "claude", sessionId: CLAUDE_CHAT });
  assert.deepEqual(runParent(codex!, {}), { agent: "claude", sessionId: CLAUDE_CHAT },
    "the listing named the Claude chat above it by its descendants");
  const underCodex: StartedRunProcess = { pid: 9, agent: "claude", startedAt: 0, above: { agent: "codex", sessionId: CLAUDE_CHAT } };
  assert.equal(runParent(underCodex, { claude: CLAUDE_CHAT }), undefined,
    "a Claude id inherited through Codex started that Codex, not this run");
  assert.deepEqual(runParent(underCodex, { claude: CLAUDE_CHAT, codex: "codex-thread-0001" }),
    { agent: "codex", sessionId: "codex-thread-0001" });
  assert.equal(runParent({ ...underCodex, above: { agent: "cursor" } }, { claude: CLAUDE_CHAT }), undefined);
  assert.deepEqual(runParent(detached!, { codex: "codex-thread-0001" }), { agent: "codex", sessionId: "codex-thread-0001" });
  assert.equal(runParent(detached!, { claude: CLAUDE_CHAT, codex: "codex-thread-0001" }), undefined, "two chats named: no guess");
  assert.equal(runParent(detached!, {}), undefined);
});

test("only the chat-id variables are taken from a process's environment", () => {
  const stdout = [
    `  602   501 node /opt/homebrew/bin/codex exec draw SECRET_TOKEN=abc123 CLAUDE_CODE_SESSION_ID=${CLAUDE_CHAT} HOME=/Users/me`,
    `  603   501 claude -p hi CODEX_THREAD_ID=short CLAUDE_CODE_SESSION_ID=not/an/id GROK_SESSION_ID=grok-session-01`,
    "  604   777 codex exec CLAUDE_CODE_SESSION_ID=someone-elses-chat",
    "  605   501 codex exec PATH=/usr/bin",
  ].join("\n");
  const parsed = parseChatVariables(stdout, 501);
  assert.deepEqual([...parsed], [[602, { claude: CLAUDE_CHAT }], [603, { grok: "grok-session-01" }]],
    "another person's process and malformed ids are dropped, and nothing else from the lines is kept");
  const prompt = parseChatVariables(`  606   501 codex exec CLAUDE_CODE_SESSION_ID=typed-in-the-prompt CLAUDE_CODE_SESSION_ID=${CLAUDE_CHAT}`, 501);
  assert.deepEqual(prompt.get(606), { claude: CLAUDE_CHAT }, "the environment follows the command line");
});

test("a captured run is written down with its folder and parent, once, and a run with no folder is asked again", async (t) => {
  configDir(t);
  let clock = SAMPLED;
  const asked: number[][] = [];
  const directories = new Map<number, string>([[602, "/private/tmp/blogart"]]);
  const variables = new Map<number, ChatVariables>([[602, { claude: CLAUDE_CHAT }], [702, { claude: CLAUDE_CHAT }]]);
  const capture = createStartedRunCapture({
    readers: {
      directories: async (pids) => { asked.push([...pids]); return new Map([...directories].filter(([pid]) => pids.includes(pid))); },
      variables: async (pids) => new Map([...variables].filter(([pid]) => pids.includes(pid))),
    },
    now: () => clock,
  });
  const found = processes();
  assert.equal(await capture(found), 1, "702 has no folder yet");
  assert.equal(await capture(found), 0, "602 is settled");
  const runs = startedByState().runs;
  assert.deepEqual(runs.map((item: StartedRun) => [item.agent, item.pid, item.folder, item.parent.sessionId, item.startedAt]),
    [["codex", 602, "/private/tmp/blogart", CLAUDE_CHAT, SAMPLED - 3_000]]);
  directories.set(702, "/Users/me/notes");
  clock += 5_000;
  assert.equal(await capture(found), 1, "the second look found 702's folder");
  assert.deepEqual(asked, [[602, 702], [702], [702]]);
  assert.equal(await capture(found), 0);

  const failing = createStartedRunCapture({
    readers: { directories: async () => new Map(), variables: async () => { throw new Error("process environment unavailable"); } },
  });
  assert.equal(await failing(found), 0, "an unreadable environment is tried again at the next sample, never thrown");
});
