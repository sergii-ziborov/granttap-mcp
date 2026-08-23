import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyTool, compact, normalizeMcpServerName, pushEntry, toolSummary,
} from "../apps/bridge/src/sessions/activity-helpers";
import {
  clampTokens, estimateBaselineTokens, estimateTokens, supportsFileReadBaseline,
} from "../apps/bridge/src/sessions/telemetry/estimation";
import {
  cursorConversationId, resolveCursorMcpServer,
} from "../apps/bridge/src/cursor-mcp-policy";

test("token estimation recognizes structured and encoded images without counting hidden payload size", async () => {
  const magics = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from("GIF89a00"), Buffer.from("RIFF0000WEBP"), Buffer.from("BM000000"),
    Buffer.from([0x49, 0x49, 0x2a, 0, 0, 0, 0, 0]),
    Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 0]),
    Buffer.from([0, 0, 1, 0, 0, 0, 0, 0]),
  ];
  for (const bytes of magics) assert.equal(estimateTokens(bytes.toString("base64")), 1_600);
  assert.equal(estimateTokens("data:image/png;base64,AAAA"), 1_600);
  assert.equal(estimateTokens({ type: "input_image", image_url: "data:image/png;base64,AAAA" }), 1_600);
  assert.equal(estimateTokens({ mediaType: "image/jpeg", source: {} }), 1_600);
  assert.equal(estimateTokens({ source: { media_type: "image/png" } }), 1_600);
  assert.equal(estimateTokens({ text: "abcd" }), 1);
  assert.equal(estimateTokens(["abcd", true, 1234]), 3);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(Symbol("x")), 0);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(estimateTokens(circular), 0);
  assert.equal(clampTokens(Number.NaN), 0);
  assert.equal(clampTokens(-1), 0);
  assert.equal(clampTokens(200_000), 100_000);

  const root = await mkdtemp(join(tmpdir(), "granttap-token-baseline-"));
  const file = join(root, "large.txt");
  await writeFile(file, "x".repeat(400));
  await mkdir(join(root, "folder"));
  assert.equal(estimateBaselineTokens({ path: file }, 10), 100);
  assert.equal(estimateBaselineTokens({ filePath: "large.txt" }, 10, root), 100);
  assert.equal(estimateBaselineTokens({ filename: "large.txt" }, 200, root), undefined);
  assert.equal(estimateBaselineTokens({ path: join(root, "folder") }, 0), undefined);
  assert.equal(estimateBaselineTokens({ path: "missing" }, 0, root), undefined);
  assert.equal(estimateBaselineTokens({ path: "relative" }, 0), undefined);
  assert.equal(estimateBaselineTokens({ path: "https://example.test/file" }, 0), undefined);
  assert.equal(estimateBaselineTokens({ path: "x".repeat(4_097) }, 0, root), undefined);
  assert.equal(supportsFileReadBaseline("mcp__repo__read_file"), true);
  assert.equal(supportsFileReadBaseline("mcp__repo__delete_file"), false);
  assert.equal(supportsFileReadBaseline("execute"), false);
});

test("activity helpers bound visible messages and normalize provider capability identities", () => {
  assert.equal(compact("  a   b  "), "a b");
  assert.equal(compact("abcdef", 4), "abc…");
  assert.equal(normalizeMcpServerName(" user-github "), "github");
  assert.equal(normalizeMcpServerName(" "), "");
  assert.equal(toolSummary("Shell", "echo hi"), "Shell: echo hi");
  assert.equal(toolSummary("Unknown", null), "Unknown");
  assert.equal(toolSummary("CallMcpTool", { server: "user-github", toolName: "issue" }), "github/issue");
  assert.equal(toolSummary("GetMcpTools", { server: "docs" }), "docs/GetMcpTools");
  assert.equal(toolSummary("Read", { file_path: "/tmp/a" }), "Read: /tmp/a");
  assert.equal(toolSummary("Other", { ignored: true }), "Other");
  assert.deepEqual(classifyTool("mcp__github__issue"), {
    toolName: "mcp__github__issue", mcpServer: "github",
  });
  assert.deepEqual(classifyTool("CallMcpTool", { server: "user-docs", toolName: "read" }), {
    toolName: "read", mcpServer: "docs",
  });
  assert.deepEqual(classifyTool("Skill(review)"), { toolName: "Skill(review)", skill: "review" });
  assert.deepEqual(classifyTool("Skill", { skill: "release" }), { toolName: "Skill", skill: "release" });
  assert.deepEqual(classifyTool("Skill", {}), { toolName: "Skill", skill: "skill" });
  assert.deepEqual(classifyTool("Shell"), { toolName: "Shell" });
  const out: any[] = [];
  const seen = new Set<string>();
  pushEntry(out, seen, "session", "user", "<environment_context>hidden", 1, 0);
  pushEntry(out, seen, "session", "user", "## My request for Codex:\nShow status", 2, 0);
  pushEntry(out, seen, "session", "user", "## My request for Codex:\nShow status", 3, 0);
  pushEntry(out, seen, "session", "message", "x".repeat(800), 4, 0, {}, "custom");
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "Show status");
  assert.equal(out[1].id, "custom");
  assert.equal(out[1].text.length, 700);
});

test("Cursor MCP resolution accepts one exact configured server and abstains on ambiguity", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cursor-policy-edge-"));
  const cursor = join(root, "cursor");
  const workspace = join(root, "workspace", "nested");
  await mkdir(cursor, { recursive: true });
  await mkdir(join(root, "workspace", ".cursor"), { recursive: true });
  await writeFile(join(cursor, "mcp.json"), JSON.stringify({ mcpServers: {
    "user-global": { command: "node", args: ["server.mjs"] },
    invalid: "no", oversized: { command: "x".repeat(5_000) },
  } }));
  await writeFile(join(root, "workspace", ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {
    project: { url: "https://mcp.example.test" },
  } }));
  assert.equal(resolveCursorMcpServer({ tool_name: "mcp__global__read" }, cursor), "global");
  assert.equal(resolveCursorMcpServer({ tool_input: JSON.stringify({ serverName: "project" }), cwd: workspace }, cursor), "project");
  assert.equal(resolveCursorMcpServer({ command: "node server.mjs" }, cursor), "global");
  assert.equal(resolveCursorMcpServer({ url: "https://mcp.example.test", cwd: workspace }, cursor), "project");
  assert.equal(resolveCursorMcpServer({
    mcp_server_name: "global", server_name: "project", cwd: workspace,
  }, cursor), null);
  assert.equal(resolveCursorMcpServer({ tool_input: "not-json" }, cursor), null);
  assert.equal(resolveCursorMcpServer({ tool_input: "x".repeat(70_000) }, cursor), null);
  assert.equal(resolveCursorMcpServer({ mcp_server_name: "unconfigured" }, join(root, "empty")), "unconfigured");
  assert.equal(cursorConversationId({ conversation_id: " cursor " }), "cursor");
  assert.equal(cursorConversationId({ session_id: "session" }), "session");
  assert.equal(cursorConversationId({ conversation_id: "x".repeat(257) }), null);
  assert.equal(cursorConversationId({}), null);
});
