import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "../../packages/protocol/schema";
import { createInvocationIngestor } from "../../apps/bridge/src/engine/invocation/ingest";
import type { EngineOperation, EngineResult } from "../../apps/bridge/src/engine/protocol/engine-protocol";

test("a failed Engine write replays the same evidence without sending tool content", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "granttap-ingest-")), "session.jsonl");
  writeFileSync(path, [
    JSON.stringify({ timestamp: "2026-09-14T10:00:00Z", message: { content: [
      { type: "tool_use", id: "call", name: "Edit", input: { file_path: "/repo/src/index.ts", content: "secret input" } },
    ] } }),
    JSON.stringify({ timestamp: "2026-09-14T10:00:01Z", message: { content: [
      { type: "tool_result", tool_use_id: "call", is_error: true, content: "secret output" },
    ] } }), "",
  ].join("\n"));
  const recorded: EngineOperation[] = [];
  let failOnce = true;
  const client = { request: async (operation: EngineOperation): Promise<EngineResult> => {
    if (operation.operation === "engine.ping") return { operation: "engine.pong", engine_version: "test" };
    if (operation.operation === "invocation.observe") {
      recorded.push(operation);
      if (failOnce && recorded.length === 2) { failOnce = false; throw new Error("connection lost"); }
      return { operation: "invocation.observed", sequence: recorded.length };
    }
    throw new Error("unexpected operation");
  } };
  const ingestor = createInvocationIngestor({
    client, enabled: () => true, computer: () => "mac",
    paths: () => [path], inspect: () => ({ root: "/repo", canonicalRepositoryId: "frontend", worktree: "/repo" }),
  });
  const session = { sessionId: "session", agent: "claude", projectId: "project", taskId: "task",
    cwd: "/repo" } as SessionInfo;
  await ingestor.ingest([session]);
  await ingestor.ingest([session]);
  const facts = recorded.filter((row) => row.operation === "invocation.observe");
  assert.deepEqual(facts.map((row) => row.input.phase), ["requested", "reported_failure", "requested", "reported_failure"]);
  assert.equal((facts[0] as { input: { resource: string } }).input.resource, "src/index.ts");
  assert.equal(JSON.stringify(facts).includes("secret"), false);
  assert.equal((facts[0] as { input: { event_id: string } }).input.event_id,
    (facts[2] as { input: { event_id: string } }).input.event_id);
});

test("hook denial joins the exact transcript call, preserving rule and revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-decision-"));
  const transcript = join(root, "session.jsonl");
  const decisions = join(root, "decisions.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ message: { content: [
    { type: "tool_use", id: "call-1", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
  ] } })}\n`);
  writeFileSync(decisions, `${JSON.stringify({ at: 123, provider: "claude",
    nativeCallId: "call-1", toolName: "Edit", ruleId: "deny-write", policyRevision: 7 })}\n`);
  const recorded: Array<Extract<EngineOperation, { operation: "invocation.observe" }>["input"]> = [];
  const client = { request: async (operation: EngineOperation): Promise<EngineResult> => {
    if (operation.operation === "engine.ping") return { operation: "engine.pong", engine_version: "test" };
    if (operation.operation === "invocation.observe") {
      recorded.push(operation.input);
      return { operation: "invocation.observed", sequence: recorded.length };
    }
    throw new Error("unexpected operation");
  } };
  const ingestor = createInvocationIngestor({
    client, enabled: () => true, computer: () => "mac", paths: () => [transcript],
    decisionPath: () => decisions,
    inspect: () => ({ root: "/repo", canonicalRepositoryId: "repo", worktree: "/repo" }),
  });
  await ingestor.ingest([{ sessionId: "session", agent: "claude", projectId: "project",
    taskId: "task", cwd: "/repo" } as SessionInfo]);
  assert.deepEqual(recorded.map((event) => event.phase), ["requested", "denied"]);
  assert.equal(recorded[0]?.invocation_id, recorded[1]?.invocation_id);
  assert.equal(recorded[1]?.policy_revision, 7);
  assert.equal(recorded[1]?.policy_rule_id, "deny-write");
});

test("a handed-off session gets a different Invocation identity on another computer", async () => {
  const source = join(mkdtempSync(join(tmpdir(), "granttap-handoff-")), "session.jsonl");
  const repeated = JSON.stringify({ message: { content: [
    { type: "tool_use", id: "reused-call", name: "Read", input: {} },
  ] } });
  writeFileSync(source, `${repeated}\n${repeated}\n`);
  const observed: Array<Extract<EngineOperation, { operation: "invocation.observe" }>["input"]> = [];
  const client = { request: async (operation: EngineOperation): Promise<EngineResult> => {
    if (operation.operation === "engine.ping") return { operation: "engine.pong", engine_version: "test" };
    if (operation.operation === "invocation.observe") {
      observed.push(operation.input);
      return { operation: "invocation.observed", sequence: observed.length };
    }
    throw new Error("unexpected operation");
  } };
  const session = { sessionId: "same-session", agent: "claude", projectId: "project", taskId: "task",
    cwd: "/repo" } as SessionInfo;
  for (const computer of ["source-mac", "target-pc"]) {
    await createInvocationIngestor({
      client, enabled: () => true, computer: () => computer, paths: () => [source],
      inspect: () => ({ root: "/repo", canonicalRepositoryId: "repo" }),
    }).ingest([session]);
  }
  assert.equal(observed.length, 4);
  assert.notEqual(observed[0]?.event_id, observed[1]?.event_id,
    "a repeated native call is separate evidence, even at the same timestamp");
  assert.notEqual(observed[0]?.invocation_id, observed[2]?.invocation_id);
  assert.notEqual(observed[0]?.execution_id, observed[2]?.execution_id);
});
