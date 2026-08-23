import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cursorCapabilityUsage,
  scanCursor,
} from "../apps/bridge/src/sessions/cursor";
import { scanCapabilityUsage } from "../apps/bridge/src/sessions";
import {
  MAX_CAPABILITY_USAGE_EVENTS,
  MAX_CAPABILITY_USAGE_PAYLOAD_BYTES,
} from "../apps/bridge/src/sessions/telemetry";

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

test("Cursor indexes root and child MCP/skill/CLI usage without a second walk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-usage-"));
  const sessionId = "cursor-usage-root";
  const childId = "cursor-usage-child";
  const sessionDir = join(
    root,
    "workspace",
    "agent-transcripts",
    sessionId,
  );
  await mkdir(join(sessionDir, "subagents"), { recursive: true });
  const started = Date.now() - 10_000;
  const secret = "sk-proj-cursorsecret123456789";
  await writeFile(join(sessionDir, `${sessionId}.jsonl`), jsonl([
    {
      timestamp: started,
      role: "user",
      message: { content: [{ type: "text", text: "Inspect Cursor telemetry" }] },
    },
    {
      timestamp: started + 1_000,
      role: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "cursor-mcp",
            name: "CallMcpTool",
            input: { server: "user-auth", toolName: "inspect", arguments: { query: "oauth" } },
          },
          {
            type: "tool_use",
            id: "cursor-skill",
            name: "Skill",
            input: { skill: "release-check", args: "fast" },
          },
          {
            type: "tool_use",
            id: "cursor-cli",
            name: "Shell",
            input: {
              command: `OPENAI_API_KEY=${secret} curl --token cursor-token https://u:p@example.test/run?token=query-secret`,
            },
          },
        ],
      },
    },
    {
      timestamp: started + 1_500,
      role: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "cursor-mcp", content: "public result body" },
        ],
      },
    },
  ]));
  await writeFile(join(sessionDir, "subagents", `${childId}.jsonl`), jsonl([
    {
      timestamp: started + 2_000,
      role: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "cursor-child-mcp",
            name: "mcp__repo__search",
            input: { query: "tokens" },
          },
          { type: "thinking", thinking: "CURSOR_PRIVATE_REASONING" },
        ],
      },
    },
  ]));
  setEnv(t, "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", root);
  setEnv(t, "GRANTTAP_CURSOR_STATE_DB", join(root, "missing-state.vscdb"));

  const scan = scanCursor();
  assert.deepEqual(scan.sessions.map((session) => session.sessionId), [sessionId]);
  assert.equal(cursorCapabilityUsage(scan.sessions[0]!).length, 4);

  // If usage attempted another filesystem walk, moving the configured root
  // would clear the provider index and lose all observations.
  await rename(root, `${root}-offline`);
  const status = scanCapabilityUsage(scan.sessions);
  assert.equal(status.events.length, 4);
  assert.equal(status.events.every((event) => event.sessionId === sessionId), true);

  const mcp = status.events.find((event) => event.sourceId.endsWith(":cursor-mcp"));
  assert.equal(mcp?.kind, "mcp");
  assert.equal(mcp?.name, "auth");
  assert.equal(mcp?.toolName, "mcp__auth__inspect");
  assert.equal(mcp?.durationMs, 500);
  assert.ok((mcp?.estimatedContextTokens ?? 0) > 0);

  const child = status.events.find((event) => event.sourceId.startsWith(`${childId}:`));
  assert.equal(child?.sessionId, sessionId);
  assert.equal(child?.name, "repo");
  assert.equal(child?.durationMs, undefined, "unmatched Cursor calls stay input-only");

  const skill = status.events.find((event) => event.kind === "skill");
  assert.equal(skill?.name, "release-check");
  assert.equal(skill?.durationMs, undefined);

  const cli = status.events.find((event) => event.kind === "cli");
  assert.match(cli?.commandPreview ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(
    JSON.stringify(status),
    /cursorsecret|cursor-token|query-secret|CURSOR_PRIVATE_REASONING/,
  );
});
