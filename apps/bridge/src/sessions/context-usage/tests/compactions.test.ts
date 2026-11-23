import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionInfo, type ActivityEntry } from "../../../../../../packages/protocol/schema";
import { appendClaudeActivity } from "../../scan/claude";
import { parseClaudeFile } from "../../scan/claude/parse";
import { parseCodexFile } from "../../scan/codex/parse";
import { claudeCompactionNotice, codexCompactionOf, noteCompaction, tokenScale } from "../compactions";

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const id = "claude-compacted";

/** The rows Claude Code 2.1.330 wrote around a headless `/compact`, as recorded on a throwaway chat. */
function compactedChat(): string[] {
  const row = (type: string, offsetMs: number, extra: Record<string, unknown>) =>
    JSON.stringify({ sessionId: id, cwd: "/tmp/project", type, timestamp: at(offsetMs), ...extra });
  return [
    row("user", -120_000, { uuid: "u1", message: { role: "user", content: "Synthetic request" } }),
    row("assistant", -110_000, { uuid: "a1", message: { role: "assistant", stop_reason: "end_turn", model: "claude-fable-5-2",
      usage: { input_tokens: 2, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 12_000, output_tokens: 900 },
      content: [{ type: "text", text: "Done" }] } }),
    row("queue-operation", -60_000, { operation: "enqueue", content: "/compact" }),
    row("queue-operation", -60_000, { operation: "dequeue" }),
    row("system", -50_000, { uuid: "b1", subtype: "compact_boundary", content: "Conversation compacted", isMeta: false,
      compactMetadata: { trigger: "manual", preTokens: 612_002, postTokens: 31_400, durationMs: 9_000 } }),
    row("user", -50_000, { uuid: "s1", isCompactSummary: true, isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "This session is being continued from a previous conversation. Summary: synthetic" } }),
    row("user", -50_000, { uuid: "c1", isMeta: true, message: { role: "user",
      content: "<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>" } }),
    row("user", -50_000, { uuid: "c2", message: { role: "user",
      content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } }),
    row("user", -50_000, { uuid: "c3", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } }),
  ];
}

test("a compaction in a Claude transcript is counted, sized and leaves the chat idle at the size after", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-claude-compaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, `${id}.jsonl`);
  writeFileSync(file, compactedChat().join("\n") + "\n");
  const session = parseClaudeFile(file)!.session;
  assert.equal(session.state, "idle", "a /compact between turns starts no turn");
  assert.equal(session.compaction?.count, 1);
  assert.deepEqual({ ...session.compaction!.last, at: 0 }, { at: 0, trigger: "manual", preTokens: 612_002, postTokens: 31_400 });
  assert.equal(session.contextUsage?.usedTokens, 31_400, "the window now holds what Claude said it kept");
  assert.equal(session.contextUsage?.observedAt, session.compaction!.last!.at);
  assert.equal(session.contextTokensUsed, 31_400);
  assert.equal(SessionInfo.safeParse(session).success, true);
  assert.equal(session.title, "Synthetic request", "the summary does not name the chat");
});

test("a compaction reads as one status line in the chat and the summary is not the person's message", () => {
  const session = { sessionId: id, agent: "claude", lastActivityAt: 1 } as SessionInfo;
  const out: ActivityEntry[] = [];
  appendClaudeActivity({ out, seen: new Set(), session, lines: compactedChat(), observations: new Map() });
  assert.deepEqual(out.filter(entry => entry.kind === "status").map(entry => entry.text),
    ["The context was compacted: 612k → 31k tokens.", "/compact", "Compacted"]);
  assert.equal(out.some(entry => /being continued/.test(entry.text)), false);
  assert.equal(claudeCompactionNotice({ type: "system", subtype: "compact_boundary", timestamp: at(0),
    compactMetadata: { trigger: "auto", preTokens: 967_500 } }), "Claude Code compacted the context by itself.");
  assert.equal(claudeCompactionNotice({ type: "system", subtype: "compact_boundary", isSidechain: true, timestamp: at(0) }), undefined,
    "a subagent's own compaction is not the chat's");
  assert.equal(claudeCompactionNotice({ type: "user", message: { content: "hello" } }), undefined);
  assert.deepEqual([tokenScale(1_250_000), tokenScale(980), tokenScale(31_400)], ["1.3M", "980", "31k"]);
});

test("Codex's compaction item and its event count once, with the reading before it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-codex-compaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "rollout-2026-11-23T10-00-00-codex-compacted.jsonl");
  const rows = [
    { timestamp: at(-90_000), type: "session_meta", payload: { id: "codex-compacted", cwd: "/tmp/project" } },
    { timestamp: at(-80_000), type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: 240_000, cached_input_tokens: 200_000, output_tokens: 100 }, model_context_window: 258_400 } } },
    { timestamp: at(-70_000), type: "compacted", payload: { message: "synthetic summary" } },
    { timestamp: at(-69_000), type: "event_msg", payload: { type: "context_compacted" } },
  ];
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const session = parseCodexFile(file)!.session;
  assert.equal(session.compaction?.count, 1);
  assert.equal(session.compaction?.last?.trigger, "provider");
  assert.equal(session.compaction?.last?.preTokens, 240_000);
  assert.equal(session.compaction?.last?.postTokens, undefined, "Codex does not say the size after");
  const later = codexCompactionOf({ timestamp: at(0), type: "compacted" })!;
  assert.equal(noteCompaction(session.compaction, later).count, 2, "a compaction a minute later is another one");
  assert.equal(codexCompactionOf({ timestamp: at(0), type: "event_msg", payload: { type: "token_count" } }), undefined);
});
