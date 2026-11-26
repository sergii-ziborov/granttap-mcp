import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectCodeFileResult, type ProjectCodeFileQuery } from "../../../../../packages/protocol/schema";
import { handleMonitorMessage } from "../../monitor/handlers/inbound";
import { CodeFileSections, type AnalysisOutcome } from "..";
import { CODE_FILE_RESULT_TTL_MS, handleCodeFileQuery } from "../relay";

type Sent = { payload: { type: string } & Record<string, unknown>; sessionId?: string; to: string;
  options: { peerPublicKey?: string; ttlMs?: number } };

function relay(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-code-file-relay-"));
  const prior = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = root;
  t.after(() => { if (prior === undefined) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = prior; rmSync(root, { recursive: true, force: true }); });
  const sent: Sent[] = [];
  const client = { room: "fixture-room", isConnected: true, setSessionKey: () => {},
    send: async (payload: Sent["payload"], to: string, options: Sent["options"]) => { sent.push({ payload, to, options }); },
    sendSession: async (payload: Sent["payload"], sessionId: string, to: string, options: Sent["options"]) => {
      sent.push({ payload, sessionId, to, options });
    } };
  const answers = () => sent.filter(item => item.payload.type === "project.code_file.result");
  return { client, sent, answers };
}

const query = (requestId = "code-1"): ProjectCodeFileQuery => ({ type: "project.code_file.query", projectId: "mesh-a",
  repositoryId: "github.com/me/app", path: "src/api.ts", requestId, createdAt: Date.now() });
const file = { project_id: "mesh-a", repository_id: "github.com/me/app", revision: "content-1", analysis_id: "a-1",
  path: "src/api.ts", language: "TypeScript", line_count: 30, total_symbols: 1, truncated: false,
  symbols: [{ id: "src/api.ts#register", label: "register", kind: "function", start_line: 2, line_count: 8 }] };

test("the monitor answers a code file query promptly, to the asking phone, under the Project's key", async t => {
  const { client, answers } = relay(t);
  const input = { leadership: { acquire: () => true }, subscriptions: new Set<string>(), publish: async () => {},
    peerPublicKey: "phone-key" };
  assert.equal(await handleMonitorMessage(client as never, query(), input), true);
  const [answer] = answers();
  assert.ok(answer, "a computer without the repository still answers, so the phone does not wait");
  assert.equal(ProjectCodeFileResult.parse(answer.payload).status, "not_bound");
  assert.deepEqual([answer.sessionId, answer.to, answer.options.peerPublicKey, answer.options.ttlMs],
    ["mesh-a", "phone", "phone-key", CODE_FILE_RESULT_TTL_MS]);
});

test("analyzing goes out before the handler returns and the sections follow the analysis", async t => {
  const { client, answers } = relay(t);
  let release!: (outcome: AnalysisOutcome) => void;
  let cached = false;
  const sections = new CodeFileSections({ bound: () => true, now: Date.now,
    read: async () => cached ? { kind: "ok", file } : { kind: "not_cached" },
    analyze: () => new Promise(resolve => { release = outcome => { cached = true; resolve(outcome); }; }) });
  assert.equal(await handleCodeFileQuery(client as never, query("q1"), "phone-a", { sections }), true);
  assert.equal(await handleCodeFileQuery(client as never, query("q2"), "phone-b", { sections }), true);
  assert.deepEqual(answers().map(item => [item.payload.requestId, item.payload.status, item.options.peerPublicKey]),
    [["q1", "analyzing", "phone-a"], ["q2", "analyzing", "phone-b"]]);
  release("ok");
  await new Promise(resolve => setTimeout(resolve, 10));
  const final = answers().slice(2).map(item => ProjectCodeFileResult.parse(item.payload));
  assert.deepEqual(final.map(item => [item.requestId, item.status, item.symbols.length, item.totalSymbols]),
    [["q1", "ok", 1, 1], ["q2", "ok", 1, 1]]);
  assert.deepEqual(final[0]!.symbols[0], { id: "src/api.ts#register", label: "register", kind: "function",
    startLine: 2, lineCount: 8 });
});

test("a query the relay held past anyone waiting is taken without an answer", async t => {
  const { client, answers } = relay(t);
  let reads = 0;
  const sections = new CodeFileSections({ bound: () => true, now: Date.now, analyze: async () => "ok",
    read: async () => { reads++; return { kind: "ok", file }; } });
  assert.equal(await handleCodeFileQuery(client as never, { ...query(), createdAt: Date.now() - 11 * 60_000 },
    "phone-a", { sections }), true);
  assert.deepEqual([answers().length, reads], [0, 0]);
});

test("a query beyond capacity fails loudly so the monitor's log names it", async t => {
  const { client } = relay(t);
  const sections = new CodeFileSections({ bound: () => true, now: Date.now, analyze: () => new Promise(() => {}),
    read: async () => ({ kind: "not_cached" }) }, 1);
  await handleCodeFileQuery(client as never, query("q1"), "phone-a", { sections });
  await assert.rejects(handleCodeFileQuery(client as never, { ...query("q2"), path: "src/other.ts" }, "phone-a",
    { sections }), /too many code file queries/);
});
