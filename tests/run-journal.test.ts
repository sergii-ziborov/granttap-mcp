import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installClaudeHook, hookCommand } from "../apps/bridge/src/install";
import {
  describeRun, markRunsDelivered, MAX_JOURNAL_RECORDS, recordRun, runJournal, unreadRuns, type RunRecord,
} from "../apps/bridge/src/mesh/journal";
import { meshBrief, meshMap } from "../apps/bridge/src/mesh/map";
import { promptContext } from "../apps/bridge/src/mesh/prompt-context";
import { digestRun, noteDeliveredRun } from "../apps/bridge/src/mesh/run-digest";
import { MeshStore } from "../apps/bridge/src/mesh/store";
import type { MeshSnapshot, SessionInfo } from "../packages/protocol/schema";

const at = 1_800_000_000_000;

async function isolatedConfig(t: { after: (fn: () => void) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-journal-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  return root;
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    at, endedAt: at + 90_000, source: "phone", prompt: "Сверни агент конверзейшинс как CLI",
    ok: true, outcome: "Folded the section; tests green.", files: ["apps/ios/TaskChatView.swift"], tools: 18,
    ...overrides,
  };
}

test("a run is journaled, bounded, read back unread once, and described in one line", async (t) => {
  await isolatedConfig(t);
  const chat = "chat/with:odd chars";
  assert.deepEqual(runJournal(chat), []);
  recordRun(chat, run());
  recordRun(chat, run({ at: at + 1, ok: false, outcome: "claude did not respond within 600s.", cutOff: true, files: [], tools: 3 }));
  const unread = unreadRuns(chat);
  assert.equal(unread.length, 2);
  assert.equal(unread[0]?.files[0], "apps/ios/TaskChatView.swift");

  assert.equal(
    describeRun(unread[0]!),
    "«Сверни агент конверзейшинс как CLI» → Folded the section; tests green.; wrote apps/ios/TaskChatView.swift; 18 tool calls",
  );
  assert.match(describeRun(unread[1]!), /failed: claude did not respond within 600s\.; 3 tool calls; cut off after 90s — its work may be unfinished/);

  markRunsDelivered(chat, at + 200_000);
  assert.deepEqual(unreadRuns(chat), []);
  assert.equal(runJournal(chat)[0]?.deliveredAt, at + 200_000);
  markRunsDelivered(chat, at + 300_000);
  assert.equal(runJournal(chat)[0]?.deliveredAt, at + 200_000, "already delivered stays as it was");

  // Long prompts and outcomes are cut, many files too, and the journal keeps the last fifty.
  recordRun(chat, run({ prompt: "x".repeat(500), outcome: "y".repeat(2_000), files: Array.from({ length: 40 }, (_, i) => `f${i}`) }));
  const last = runJournal(chat).at(-1)!;
  assert.equal(last.prompt.length, 200);
  assert.equal(last.outcome.length, 600);
  assert.equal(last.files.length, 24);
  assert.match(describeRun(last), /wrote f0, f1, f2, f3, f4, f5 \(\+18\)/);
  for (let index = 0; index < MAX_JOURNAL_RECORDS + 5; index += 1) recordRun(chat, run({ at: at + 1_000 + index }));
  assert.equal(runJournal(chat).length, MAX_JOURNAL_RECORDS);
  assert.deepEqual(runJournal("never-written"), []);
});

function seeded(root: string): { store: MeshStore; snapshot: MeshSnapshot } {
  const projectId = "project-pay";
  const api = "github.com/example/payments-api";
  const worker = "github.com/example/payment-worker";
  const store = new MeshStore(join(root, "mesh.json"), () => at);
  store.upsertProject({ projectId, name: "Payments", repositoryRoot: "/repo/payments-api", canonicalRepositoryId: api, createdAt: at });
  for (const [repositoryId, displayName] of [[api, "payments-api"], [worker, "payment-worker"]] as const) {
    store.upsertBinding({ bindingId: `b-${displayName}`, projectId, endpointId: "mac-a", repositoryId, displayName, available: true });
  }
  store.recordIntegrationPeers(projectId, api, [{ peer: "payment-worker", via: "kafka", relation: "produces", through: "payment.completed" }]);
  for (const [taskId, sessionId, repositoryId, title] of [
    ["task-api", "claude-api", api, "Add refunds to the API"],
    ["task-worker", "codex-worker", worker, "Consume refund events"],
    ["task-idle", "claude-idle", api, "Old idea"],
  ] as const) {
    store.upsertTask({ taskId, projectId, title, goal: `${title} goal`, state: "working", ownerSessionId: sessionId, createdAt: at, updatedAt: at });
    store.linkExecution({
      taskId, sessionId, provider: sessionId.startsWith("claude") ? "claude" : "codex", computerId: "mac-a",
      workspace: `/repo/${repositoryId.split("/").pop()}`, repositoryId, startedAt: at,
      ...(taskId === "task-idle" ? { endedAt: at + 1 } : {}),
    });
  }
  store.observeClaim({ claimId: "c-api", projectId, taskId: "task-api", ownerSessionId: "claude-api", resource: "apps/api/src/refunds.ts", mode: "intent", createdAt: at, expiresAt: at + 600_000 });
  store.observeClaim({ claimId: "c-worker", projectId, taskId: "task-worker", ownerSessionId: "codex-worker", resource: "apps/api/src/events.ts", mode: "claim", createdAt: at, expiresAt: at + 600_000 });
  store.acceptEvent({
    type: "mesh.event", sessionId: "task-api", eventId: "q1", projectId, taskId: "task-api", sourceSessionId: "codex-worker",
    eventType: "AGENT_QUESTION", createdAt: at + 10, expiresAt: at + 600_000, payload: { question: "Which topic carries refunds?" },
  });
  store.acceptEvent({
    type: "mesh.event", sessionId: "task-worker", eventId: "p1", projectId, taskId: "task-worker", sourceSessionId: "codex-worker",
    eventType: "TASK_PROGRESS", createdAt: at + 20, expiresAt: at + 600_000, payload: { summary: "Phone: «fold it» → done; wrote a.ts; 4 tool calls" },
  });
  return { store, snapshot: store.snapshot(projectId)! };
}

test("the map reads as a page and the brief as the few lines that matter to one Task", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-map-"));
  const { snapshot } = seeded(root);
  const map = meshMap(snapshot, at + 60_000);
  assert.match(map, /^# Project Mesh — Payments\n/);
  assert.match(map, /_3 Tasks · 2 live executions · /);
  assert.match(map, /- \*\*Add refunds to the API\*\* — working; claude on mac-a in payments-api — agent question: Which topic carries refunds\?/);
  assert.match(map, /- \*\*Consume refund events\*\* — working; codex on mac-a in payment-worker — task progress: Phone: «fold it» → done/);
  assert.match(map, /- \*\*Old idea\*\* — working\n/, "no live execution, no computer");
  assert.match(map, /## Editing now\n\n- `apps\/api`: Add refunds to the API \(seen editing apps\/api\/src\/refunds\.ts\); Consume refund events \(claimed apps\/api\/src\/events\.ts\)/);
  assert.match(map, /## Other side\n\n- payments-api produces payment\.completed → payment-worker \(kafka\) — Add refunds to the API, Consume refund events working across it/);
  assert.match(map, /## Dependencies\n\n- \(none\)/);
  assert.match(map, /## Recent\n\n- \d\d:\d\d Consume refund events — task progress: Phone: «fold it»/);

  const brief = meshBrief(snapshot, "task-api");
  assert.deepEqual(brief, [
    "Also active in this Project within the hour: Consume refund events (payment-worker).",
    "Next to you: Consume refund events is working in the same module — apps/api/src/events.ts.",
    "Other side: Consume refund events is working in payment-worker (payments-api produces payment.completed).",
    "Still unanswered: Which topic carries refunds?",
  ]);
  assert.deepEqual(meshBrief(snapshot, "task-idle").filter((line) => line.startsWith("Next to you")), []);

  const empty = meshMap({ ...snapshot, tasks: [], executions: [], claims: [], dependencies: [], events: [], peers: undefined }, at);
  assert.match(empty, /_0 Tasks · 0 live executions/);
  assert.match(empty, /- \(none\)\n\n## Editing now\n\n- \(nothing claimed\)\n\n## Other side\n\n- \(no integration map; commit a WEAVATRIX\.md/);
  assert.match(empty, /## Recent\n\n- \(quiet\)/);
});

test("a live chat gets the unread runs and the Mesh brief on its next prompt, once", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-prompt-"));
  const { snapshot } = seeded(root);
  const delivered: number[] = [];
  const deps = {
    unread: (sessionId: string) => (sessionId === "claude-api" ? [run(), run({ at: at + 5_000, prompt: "И ещё вот это", outcome: "Sent.", files: [], tools: 0 })] : []),
    markDelivered: (_sessionId: string, when: number) => { delivered.push(when); },
    scope: (sessionId: string) => (sessionId === "claude-api" ? { snapshot, taskId: "task-api" } : undefined),
    capability: () => "cap-token",
  };
  const text = promptContext("claude-api", at + 9_000, deps)!;
  assert.match(text, /^GrantTap: 2 messages from the phone were handled in this chat by background runs since your last turn\./);
  assert.match(text, /\n1\. \[\d\d:\d\d\] «Сверни агент конверзейшинс как CLI» → Folded the section; tests green\.; wrote apps\/ios\/TaskChatView\.swift; 18 tool calls\n2\. \[\d\d:\d\d\] «И ещё вот это» → Sent\.\n/);
  assert.match(text, /Continue from what they did; check the working tree before redoing or undoing it\.\n\nProject Mesh «Payments»:\n- Also active in this Project within the hour: Consume refund events \(payment-worker\)\.\n- Next to you:/);
  assert.match(text, /\nFull map: read the MCP resource granttap:\/\/mesh\/cap-token\/map$/);
  assert.deepEqual(delivered, [at + 9_000]);

  // Nothing new and no Task: nothing added, nothing marked.
  assert.equal(promptContext("stranger", at, deps), undefined);
  assert.equal(promptContext("", at, deps), undefined);
  assert.deepEqual(delivered, [at + 9_000]);

  // Only the Mesh, when the journal is empty: no marking either.
  const quiet = promptContext("claude-api", at, { ...deps, unread: () => [] })!;
  assert.match(quiet, /^Project Mesh «Payments»:/);
  assert.deepEqual(delivered, [at + 9_000]);

  // Many runs: the last five are shown and the rest counted; the text stays bounded.
  const many = Array.from({ length: 9 }, (_, index) => run({ at: at + index, outcome: "z".repeat(600) }));
  const long = promptContext("claude-api", at, { ...deps, unread: () => many })!;
  assert.match(long, /^GrantTap: 9 messages/);
  assert.ok(long.length <= 2_400);
});

test("a finished delivery is digested from the transcript window and carried as Task progress", async (t) => {
  await isolatedConfig(t);
  const root = await mkdtemp(join(tmpdir(), "granttap-digest-"));
  const { store, snapshot } = seeded(root);
  const session = { sessionId: "claude-api", agent: "claude", cwd: "/repo/payments-api", startedAt: at } as unknown as SessionInfo;
  const entries = [
    { createdAt: at - 60_000, toolName: "Bash", kind: "tool" },
    { createdAt: at + 1_000, toolName: "Read", kind: "tool" },
    { createdAt: at + 2_000, kind: "message" },
    { createdAt: at + 3_000, toolName: "Edit", kind: "tool" },
    { createdAt: at + 400_000, toolName: "Bash", kind: "tool" },
  ];
  const writes = [
    { path: "/repo/payments-api/apps/api/src/refunds.ts", at: at + 3_000 },
    { path: "/repo/payments-api/apps/api/src/refunds.ts", at: at + 3_500 },
    { path: "/elsewhere/notes.md", at: at + 3_000 },
    { path: "/repo/payments-api/README.md", at: at - 60_000 },
  ];
  const digest = digestRun(session, at, at + 10_000, { activity: () => ({ entries }), writes: () => writes });
  assert.deepEqual(digest, { tools: 2, files: ["apps/api/src/refunds.ts"] });
  const unreadable = digestRun(session, at, at + 10_000, { activity: () => { throw new Error("gone"); }, writes: () => [] });
  assert.deepEqual(unreadable, { tools: 0, files: [] });

  const noted = noteDeliveredRun(
    session, "Добавь возвраты\n\nAttached files available locally (inspect them as part of this request):\n- Photo-1.jpg: /tmp/x/1-Photo-1.jpg",
    { ok: true, text: "Added refunds; 12 tests pass." }, at, at + 10_000,
    {
      activity: () => ({ entries }), writes: () => writes,
      scope: () => ({ execution: snapshot.executions.find((item) => item.sessionId === "claude-api")!, snapshot }),
      store: () => store, meshEnabled: () => true, now: () => at + 11_000, eventId: () => "run-1",
    },
  )!;
  assert.equal(noted.record.prompt, "Добавь возвраты", "the attachment note is not what the person said");
  assert.equal(noted.record.tools, 2);
  assert.equal(noted.event?.eventType, "TASK_PROGRESS");
  assert.equal(noted.event?.taskId, "task-api");
  assert.equal(noted.event?.payload.summary, "Phone: «Добавь возвраты» → Added refunds; 12 tests pass.; wrote apps/api/src/refunds.ts; 2 tool calls");
  assert.ok(store.snapshot("project-pay")!.events.some((event) => event.eventId === "run-1"), "the Task carries it");
  assert.equal(unreadRuns("claude-api").length, 1, "and the chat's journal has it");

  // A timeout is journaled as cut off; without the Mesh, only the journal is written.
  const cut = noteDeliveredRun(session, "Долгая задача", { ok: false, error: "claude did not respond within 600s." }, at, at + 600_000, {
    activity: () => ({ entries: [] }), writes: () => [], scope: () => undefined, store: () => store,
    meshEnabled: () => false, now: () => at, eventId: () => "unused",
  })!;
  assert.equal(cut.record.cutOff, true);
  assert.equal(cut.event, undefined);
  assert.equal(unreadRuns("claude-api").length, 2);
});

test("the prompt hook is registered beside the approval hook, once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granttap-claude-dir-"));
  const previous = process.env.GRANTTAP_CLAUDE_DIR;
  process.env.GRANTTAP_CLAUDE_DIR = dir;
  try {
    assert.equal(installClaudeHook().status, "installed");
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
      hooks: { PreToolUse: unknown[]; UserPromptSubmit: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    assert.equal(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command, hookCommand("claude-prompt"));
    assert.equal(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.timeout, 10);
    assert.equal(installClaudeHook().status, "already");
    const again = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as typeof settings;
    assert.equal(again.hooks.UserPromptSubmit.length, 1, "not registered twice");
  } finally {
    if (previous == null) delete process.env.GRANTTAP_CLAUDE_DIR;
    else process.env.GRANTTAP_CLAUDE_DIR = previous;
  }
});

test("the prompt hook binary adds the journal once, stays quiet inside a delivery, and never fails a prompt", async (t) => {
  const root = await isolatedConfig(t);
  recordRun("hooked-chat", run());
  const hook = (stdin: string, extraEnv: Record<string, string> = {}) => spawnSync(
    process.execPath, ["--import", "tsx", "apps/bridge/src/bin/claude-prompt-hook.ts"],
    { input: stdin, encoding: "utf8", env: { ...process.env, GRANTTAP_CONFIG_DIR: root, ...extraEnv }, timeout: 60_000 },
  );
  const first = hook(JSON.stringify({ session_id: "hooked-chat", prompt: "hi" }));
  assert.equal(first.status, 0);
  const output = JSON.parse(first.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /^GrantTap: 1 message from the phone was handled/);
  assert.match(output.hookSpecificOutput.additionalContext, /«Сверни агент конверзейшинс как CLI»/);

  const second = hook(JSON.stringify({ session_id: "hooked-chat", prompt: "hi" }));
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "", "delivered once, not again");

  recordRun("hooked-chat", run({ at: at + 1 }));
  const inside = hook(JSON.stringify({ session_id: "hooked-chat", prompt: "hi" }), { GRANTTAP_DELIVERY: "1" });
  assert.equal(inside.status, 0);
  assert.equal(inside.stdout, "", "a background run is not the live session");
  assert.equal(unreadRuns("hooked-chat").length, 1, "and the entry stays unread for it");

  const broken = hook("not json");
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, "");
  const nobody = hook(JSON.stringify({ prompt: "hi" }));
  assert.equal(nobody.status, 0);
  assert.equal(nobody.stdout, "");

  // Without injected dependencies, an unknown chat has nothing to add.
  assert.equal(promptContext("nobody-knows-this-chat"), undefined);
});

test("a chat that has not done anything for an hour is idle, not live, in the map and the brief", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-idle-"));
  const { snapshot } = seeded(root);
  const now = at + 3 * 60 * 60_000;
  const aged: MeshSnapshot = {
    ...snapshot,
    executions: snapshot.executions.map((execution) =>
      execution.taskId === "task-worker"
        ? { ...execution, activeAt: now - 2 * 60 * 60_000 }
        : execution.taskId === "task-api" ? { ...execution, activeAt: now - 5 * 60_000 } : execution),
  };
  const map = meshMap(aged, now);
  assert.match(map, /_3 Tasks · 1 live execution · 1 idle · /);
  assert.match(map, /\*\*Add refunds to the API\*\* — working; claude on mac-a in payments-api, active 5 min ago/);
  assert.match(map, /\*\*Consume refund events\*\* — working; idle since 2 h ago/);
  const brief = meshBrief(aged, "task-api", now);
  assert.equal(brief[0], "1 other chat in this Project is open but idle for over an hour.");
  const briefForWorker = meshBrief(aged, "task-worker", now);
  assert.match(briefForWorker[0] ?? "", /^Also active in this Project within the hour: Add refunds to the API \(payments-api, 5 min ago\)\.$/);
});

