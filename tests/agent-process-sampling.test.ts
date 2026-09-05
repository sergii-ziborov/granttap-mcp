import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSessionResolver,
  parseSessionEnvironment,
  resetSessionResolver,
  attributeProcesses,
  parsePidListing,
  parsePsOutput,
  withCommandLines,
} from "../apps/bridge/src/machine-load/process-sampler";

describe("agent process sampling", () => {
  it("attributes only real agent executables", () => {
    const rows = [
      { pid: 1, cpuPercent: 40, rssBytes: 800, command: "/usr/local/bin/claude --resume" },
      { pid: 2, cpuPercent: 12, rssBytes: 400, command: "node /opt/homebrew/bin/codex exec" },
      { pid: 3, cpuPercent: 3, rssBytes: 100, command: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
      { pid: 4, cpuPercent: 99, rssBytes: 999, command: "/usr/bin/ssh not-an-agent" },
    ];
    const byAgent = attributeProcesses(rows);
    assert.equal(byAgent.claude?.processes, 1);
    assert.equal(byAgent.codex?.cpuPercent, 12);
    assert.equal(byAgent.cursor?.memoryBytes, 100);
    assert.equal(byAgent.ssh, undefined);
  });

  it("does not attribute files or search arguments that mention an agent", () => {
    assert.deepEqual(attributeProcesses([
      { pid: 9, cpuPercent: 50, rssBytes: 10, command: "vim /tmp/claude-ideas.md" },
      { pid: 10, cpuPercent: 50, rssBytes: 10, command: "rg codex /tmp/src" },
    ]), {});
  });

  it("excludes desktop chat helpers but keeps the bundled Codex CLI", () => {
    const byAgent = attributeProcesses([
      { pid: 1, cpuPercent: 47, rssBytes: 10, command: "/Users/me/.local/bin/claude -p" },
      { pid: 2, cpuPercent: 3, rssBytes: 10, command: "/Applications/Claude.app/Contents/MacOS/Claude" },
      { pid: 3, cpuPercent: 1, rssBytes: 10, command: "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper" },
      { pid: 4, cpuPercent: 12, rssBytes: 10, command: "/Applications/ChatGPT.app/Contents/Resources/codex exec resume y" },
    ]);
    assert.equal(byAgent.claude?.processes, 1);
    assert.equal(byAgent.codex?.processes, 1);
  });

  it("sums several processes and parses padded ps rows", () => {
    const summed = attributeProcesses([
      { pid: 1, cpuPercent: 10.5, rssBytes: 100, command: "/usr/local/bin/grok" },
      { pid: 2, cpuPercent: 4.5, rssBytes: 200, command: "/usr/local/bin/grok --print" },
    ]);
    const { rows: grokRows, ...totals } = summed.grok!;
    assert.equal(grokRows?.length, 2);
    assert.deepEqual(totals, {
      processes: 2, cpuPercent: 15, memoryBytes: 300,
      groups: [{ name: "grok", count: 2, cpuPercent: 15, memoryBytes: 300 }],
    });

    const rows = parsePsOutput([
      "  PID  %CPU      RSS COMMAND",
      "  412  41.5  1048576 /usr/local/bin/claude --resume abc",
      " 1099   0.0     2048 /usr/bin/login -pf serhii",
    ].join("\n"));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      pid: 412,
      cpuPercent: 41.5,
      rssBytes: 1_048_576 * 1024,
      command: "/usr/local/bin/claude --resume abc",
    });
  });

  it("an agent's children are its load, named by executable, heaviest first and bounded", () => {
    const rows = [
      { pid: 100, ppid: 1, cpuPercent: 5, rssBytes: 100, command: "/Users/me/.local/bin/claude" },
      ...Array.from({ length: 12 }, (_, i) => ({
        pid: 200 + i, ppid: 100, cpuPercent: 2, rssBytes: 50, command: `node /Users/me/.local/share/claude/versions/2.1.260/worker.js ${i}`,
      })),
      { pid: 300, ppid: 100, cpuPercent: 1, rssBytes: 20, command: "/bin/zsh -lc 'npm test'" },
      { pid: 301, ppid: 300, cpuPercent: 0.5, rssBytes: 20, command: "-zsh" },
      { pid: 302, ppid: 301, cpuPercent: 40, rssBytes: 900, command: "/usr/bin/git status" },
      // The shell the person launched Claude from is not Claude's.
      { pid: 1, ppid: 0, cpuPercent: 3, rssBytes: 30, command: "/bin/zsh" },
      // A shell nobody's agent spawned.
      { pid: 400, ppid: 1, cpuPercent: 3, rssBytes: 30, command: "/bin/zsh" },
    ];
    const byAgent = attributeProcesses(rows);
    const claude = byAgent.claude!;
    assert.equal(claude.processes, 16, "the binary and everything under it");
    assert.deepEqual(claude.groups?.map((group) => [group.name, group.count]), [
      ["git", 1], ["node", 12], ["claude", 1], ["zsh", 2],
    ], "heaviest first; the two shells are one kind");
    assert.equal(claude.groups?.[1]?.cpuPercent, 24);
    assert.equal(claude.groups?.[1]?.memoryBytes, 600);
    assert.equal(Object.keys(byAgent).length, 1, "the unrelated shells belong to nobody");

    const many = attributeProcesses(Array.from({ length: 12 }, (_, i) => ({
      pid: 500 + i, ppid: i === 0 ? 1 : 500, cpuPercent: 12 - i, rssBytes: 1,
      command: i === 0 ? "/usr/local/bin/claude" : `/opt/tool${i}`,
    })));
    assert.equal(many.claude?.groups?.length, 8, "the heaviest eight kinds, not every kind");
    assert.equal(many.claude?.groups?.[0]?.name, "claude");
  });

  it("reads the parent id from ps and still parses the older four-column form", () => {
    const rows = parsePsOutput("  12 1 4.5 2048 /usr/local/bin/claude --resume\n  13 12 0.0 100 -zsh\n  7 0.5 10 node old-form\nheader junk\n");
    assert.deepEqual(rows[0], { pid: 12, ppid: 1, cpuPercent: 4.5, rssBytes: 2048 * 1024, command: "/usr/local/bin/claude --resume" });
    assert.equal(rows[1]?.ppid, 12);
    assert.deepEqual(rows[2], { pid: 7, cpuPercent: 0.5, rssBytes: 10 * 1024, command: "node old-form" });
    assert.equal(rows.length, 3);
  });

  it("an executable path with a space in it is still the agent, and its children still its", () => {
    const cli = "/Users/me/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude";
    const rows = withCommandLines(
      parsePsOutput([
        `1395 1 2.0 900000 /Applications/Claude.app/Contents/MacOS/Claude`,
        `9297 1395 0.0 100 /Applications/Claude.app/Contents/Helpers/disclaimer`,
        `9298 9297 12.5 400000 ${cli}`,
        `5806 9298 0.3 2000 /bin/zsh`,
        `5900 5806 55.0 300000 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild`,
        `2714 9298 1.0 50000 /Users/me/.nvm/versions/node/v22.13.1/bin/node`,
      ].join("\n")),
      parsePidListing([
        `1395 /Applications/Claude.app/Contents/MacOS/Claude`,
        `9297 /Applications/Claude.app/Contents/Helpers/disclaimer -- ${cli} --resume`,
        `9298 ${cli} --output-format stream-json --verbose`,
        `5806 /bin/zsh -c source snapshot.sh && npm test`,
        `5900 xcodebuild test -scheme GrantTap`,
        `2714 node /Users/me/dev/granttap-mcp/bin/granttap-mcp.mjs internal serve`,
      ].join("\n")),
    );
    const byAgent = attributeProcesses(rows);
    assert.deepEqual(Object.keys(byAgent), ["claude"], "the desktop app and its disclaimer helper are not the agent");
    const claude = byAgent.claude!;
    assert.equal(claude.processes, 4, "the CLI, its shell, the build the shell ran, and its node child");
    assert.deepEqual(claude.groups?.map((group) => [group.name, group.count]), [
      ["xcodebuild", 1], ["claude", 1], ["node", 1], ["zsh", 1],
    ]);
    assert.equal(claude.cpuPercent, 68.8);
  });

  it("the interpreter's script names the agent when the executable is only node", () => {
    const rows = withCommandLines(
      parsePsOutput("77 1 1.0 10 /opt/homebrew/bin/node\n78 77 2.0 10 /bin/zsh\n"),
      parsePidListing("77 node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js exec\n78 /bin/zsh -lc ls\n"),
    );
    const byAgent = attributeProcesses(rows);
    assert.equal(byAgent.codex?.processes, 2);
    assert.deepEqual(byAgent.codex?.groups?.map((group) => group.name), ["zsh", "node"]);
  });
});


describe("who eats what", () => {
  const tree = [
    { pid: 10, ppid: 1, cpuPercent: 1, rssBytes: 100, command: "/usr/local/bin/claude --resume abc", executable: "/usr/local/bin/claude" },
    { pid: 11, ppid: 10, cpuPercent: 5, rssBytes: 200, command: "/bin/zsh -c npm test", executable: "/bin/zsh" },
    { pid: 12, ppid: 11, cpuPercent: 40, rssBytes: 900, command: "node /repo/node_modules/.bin/vitest --run", executable: "/opt/node/bin/node" },
    { pid: 20, ppid: 1, cpuPercent: 0, rssBytes: 100, command: "/usr/local/bin/claude", executable: "/usr/local/bin/claude" },
    { pid: 21, ppid: 20, cpuPercent: 2, rssBytes: 300, command: "node /repo/bin/granttap-mcp.mjs", executable: "/opt/node/bin/node" },
    { pid: 30, ppid: 1, cpuPercent: 0, rssBytes: 50, command: "/bin/sleep 5", executable: "/bin/sleep" },
  ];

  it("lists processes one by one, named and detailed, and totals them by chat", () => {
    const sessions = new Map([[10, "chat-a"], [20, "chat-b"]]);
    const claude = attributeProcesses(tree, sessions).claude!;
    assert.equal(claude.processes, 5);
    assert.deepEqual(claude.rows?.map((row) => [row.pid, row.name, row.sessionId]), [
      [12, "node", "chat-a"], [11, "zsh", "chat-a"], [21, "node", "chat-b"], [10, "claude", "chat-a"], [20, "claude", "chat-b"],
    ]);
    assert.equal(claude.rows?.[0]?.detail, "/repo/node_modules/.bin/vitest --run", "the executable's own path is not repeated");
    assert.equal(claude.rows?.[4]?.detail, undefined, "a bare binary has nothing to add");
    assert.deepEqual(claude.chats, [
      { sessionId: "chat-a", processes: 3, cpuPercent: 46, memoryBytes: 1200 },
      { sessionId: "chat-b", processes: 2, cpuPercent: 2, memoryBytes: 400 },
    ]);
    // Without a chat map the rows still come, unassigned.
    const bare = attributeProcesses(tree).claude!;
    assert.equal(bare.chats, undefined);
    assert.equal(bare.rows?.every((row) => row.sessionId === undefined), true);
  });

  it("keeps only the heaviest forty rows", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      pid: 100 + i, ppid: 1, cpuPercent: i, rssBytes: 1, command: "/usr/local/bin/claude", executable: "/usr/local/bin/claude",
    }));
    const rows = attributeProcesses(many).claude!.rows!;
    assert.equal(rows.length, 40);
    assert.equal(rows[0]?.cpuPercent, 49);
  });

  it("reads the one variable that names a chat and nothing else from an environment listing", () => {
    const listing = [
      "21 node /repo/bin/granttap-mcp.mjs PATH=/usr/bin CLAUDE_CODE_SESSION_ID=2dc608d6-3e8f-43a7-9037-32793756e7f4 SECRET=hunter2",
      "22 /bin/zsh HOME=/Users/me",
      "23 node x CLAUDE_CODE_SESSION_ID=short",
      "garbage line",
    ].join("\n");
    assert.deepEqual([...parseSessionEnvironment(listing)], [[21, "2dc608d6-3e8f-43a7-9037-32793756e7f4"]]);
  });

  it("asks about a root's descendants once, remembers the answer, and retries the unknown after a minute", async () => {
    const asked: number[][] = [];
    let clock = 0;
    const read = async (pids: readonly number[]) => {
      asked.push([...pids]);
      return new Map(pids.includes(21) ? [[21, "chat-b"] as [number, string]] : []);
    };
    const resolve = createSessionResolver(read, () => clock);
    assert.deepEqual([...await resolve(tree)], [[20, "chat-b"]]);
    assert.equal(asked.length, 1);
    assert.deepEqual([...asked[0]!].sort((a, b) => a - b), [10, 11, 12, 20, 21], "only the agents' own trees are asked");
    // Nothing new is asked while the answer is fresh; root 10 stays unknown.
    assert.deepEqual([...await resolve(tree)], [[20, "chat-b"]]);
    assert.equal(asked.length, 1);
    clock = 61_000;
    await resolve(tree);
    assert.equal(asked.length, 2);
    assert.deepEqual([...asked[1]!].sort((a, b) => a - b), [10, 11, 12], "a root already named is not asked again");
    // A root that exited is forgotten.
    const without = tree.filter((row) => ![20, 21].includes(row.pid));
    assert.deepEqual([...await resolve(without)], []);
  });

  it("lets a test replace the live resolver and put it back", () => {
    resetSessionResolver(async () => new Map(), () => 0);
    resetSessionResolver();
  });
});
