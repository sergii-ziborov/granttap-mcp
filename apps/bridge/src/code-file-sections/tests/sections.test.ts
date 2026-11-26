import assert from "node:assert/strict";
import test from "node:test";
import { CodeFileSections, type AnalysisOutcome, type CodeFileAnswer, type CodeFileKey } from "..";
import type { CodeFileRead } from "../../engine/runtime/repository-graph/code-file";

const key: CodeFileKey = { projectId: "mesh-a", repositoryId: "github.com/me/app", path: "src/api.ts" };
const file = (path = key.path, repositoryId = key.repositoryId) => ({ project_id: key.projectId,
  repository_id: repositoryId, revision: "content-1", analysis_id: "a-1", path, language: "TypeScript",
  line_count: 40, symbols: [], total_symbols: 0, truncated: false });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: { bound?: boolean; read?: (key: CodeFileKey, call: number) => Promise<CodeFileRead> | CodeFileRead;
  analyze?: () => Promise<AnalysisOutcome>; capacity?: number; now?: () => number } = {}) {
  const reads: CodeFileKey[] = [];
  let analyses = 0;
  const sections = new CodeFileSections({
    bound: () => options.bound ?? true,
    read: async query => { reads.push(query); return options.read?.(query, reads.length) ?? { kind: "ok", file: file(query.path) }; },
    analyze: () => { analyses++; return options.analyze?.() ?? Promise.resolve("ok"); },
    now: options.now ?? Date.now,
  }, options.capacity);
  const answers: Array<[string, CodeFileAnswer["status"]]> = [];
  const deliver = async (recipient: { requestId: string }, answer: CodeFileAnswer) => {
    answers.push([recipient.requestId, answer.status]);
  };
  return { sections, reads, answers, deliver, analyses: () => analyses };
}

test("a file the Engine holds is answered before the query returns, with one Engine read", async () => {
  const { sections, reads, answers, deliver, analyses } = fixture();
  assert.equal(await sections.ask(key, { requestId: "q1" }, deliver), true);
  assert.deepEqual(answers, [["q1", "ok"]]);
  assert.equal(reads.length, 1);
  assert.equal(analyses(), 0);
});

test("a repository the Engine has not analysed says analyzing at once, then sends the sections", async () => {
  const analysis = deferred<AnalysisOutcome>();
  const { sections, reads, answers, deliver, analyses } = fixture({
    read: (_query, call) => call === 1 ? { kind: "not_cached" } : { kind: "ok", file: file() },
    analyze: () => analysis.promise,
  });
  assert.equal(await sections.ask(key, { requestId: "q1" }, deliver), true);
  assert.deepEqual(answers, [["q1", "analyzing"]], "the first answer does not wait for the analysis");
  analysis.resolve("ok");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(answers, [["q1", "analyzing"], ["q1", "ok"]]);
  assert.equal(reads.length, 2);
  assert.equal(analyses(), 1);
});

test("each reason there are no sections is said without an analysis", async () => {
  for (const kind of ["not_found", "not_bound", "engine_unavailable", "analysis_failed"] as const) {
    const { sections, answers, deliver, analyses } = fixture({ read: () => ({ kind }) });
    await sections.ask(key, { requestId: kind }, deliver);
    assert.deepEqual(answers, [[kind, kind]]);
    assert.equal(analyses(), 0);
  }
  const unbound = fixture({ bound: false });
  await unbound.sections.ask(key, { requestId: "q" }, unbound.deliver);
  assert.deepEqual(unbound.answers, [["q", "not_bound"]]);
  assert.equal(unbound.reads.length, 0, "a repository this computer does not hold never reaches the Engine");
  const thrown = fixture({ read: () => { throw new Error("socket"); } });
  await thrown.sections.ask(key, { requestId: "q" }, thrown.deliver);
  assert.deepEqual(thrown.answers, [["q", "engine_unavailable"]]);
});

test("a failed analysis is the answer, and the next file does not start it again at once", async () => {
  for (const outcome of ["analysis_failed", "engine_unavailable", "not_bound"] as const) {
    const { sections, answers, deliver, analyses } = fixture({ read: () => ({ kind: "not_cached" }),
      analyze: async () => outcome });
    await sections.ask(key, { requestId: "q1" }, deliver);
    await new Promise(resolve => setTimeout(resolve, 5));
    await sections.ask({ ...key, path: "src/other.ts" }, { requestId: "q2" }, deliver);
    assert.deepEqual(answers, [["q1", "analyzing"], ["q1", outcome], ["q2", outcome]]);
    assert.equal(analyses(), 1);
  }
  const empty = fixture({ read: () => ({ kind: "not_cached" }) });
  await empty.sections.ask(key, { requestId: "q" }, empty.deliver);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(empty.answers, [["q", "analyzing"], ["q", "analysis_failed"]],
    "an analysis that left the file out of the Engine's memory failed for this file");
});

test("the same file asked again while it is answered shares that answer", async () => {
  const analysis = deferred<AnalysisOutcome>();
  const { sections, reads, answers, deliver, analyses } = fixture({
    read: (_query, call) => call === 1 ? { kind: "not_cached" } : { kind: "ok", file: file() },
    analyze: () => analysis.promise,
  });
  await sections.ask(key, { requestId: "q1" }, deliver);
  assert.equal(await sections.ask(key, { requestId: "q2" }, deliver), true);
  assert.equal(await sections.ask(key, { requestId: "q2" }, deliver), true, "a repeated delivery joins once");
  assert.deepEqual(answers, [["q1", "analyzing"], ["q2", "analyzing"]], "a joined phone hears analyzing at once");
  analysis.resolve("ok");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(answers.slice(2), [["q1", "ok"], ["q2", "ok"]]);
  assert.equal(reads.length, 2, "one Engine read before and one after the analysis");
  assert.equal(analyses(), 1);
});

test("one Engine read per repository at a time, while other repositories do not wait", async () => {
  const held = deferred<void>();
  let running = 0;
  let most = 0;
  const { sections, answers, deliver } = fixture({ read: async query => {
    if (query.repositoryId !== key.repositoryId) return { kind: "ok", file: file(query.path, query.repositoryId) };
    running++; most = Math.max(most, running);
    await held.promise;
    running--;
    return { kind: "ok", file: file(query.path) };
  } });
  const first = sections.ask(key, { requestId: "a" }, deliver);
  const second = sections.ask({ ...key, path: "src/b.ts" }, { requestId: "b" }, deliver);
  await sections.ask({ ...key, repositoryId: "github.com/me/other" }, { requestId: "c" }, deliver);
  assert.deepEqual(answers, [["c", "ok"]], "another repository is answered while this one's read is held");
  held.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(answers.map(([id]) => id).sort(), ["a", "b", "c"]);
  assert.equal(most, 1, "the held repository never had two reads at once");
});

test("queries beyond capacity are refused rather than queued without bound", async () => {
  const analysis = deferred<AnalysisOutcome>();
  const { sections, deliver } = fixture({ capacity: 1, read: () => ({ kind: "not_cached" }),
    analyze: () => analysis.promise });
  assert.equal(await sections.ask(key, { requestId: "q1" }, deliver), true);
  assert.equal(await sections.ask({ ...key, path: "src/b.ts" }, { requestId: "q2" }, deliver), false);
  assert.equal(await sections.ask(key, { requestId: "q3" }, deliver), true, "the same file still joins");
  analysis.resolve("analysis_failed");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await sections.ask({ ...key, path: "src/b.ts" }, { requestId: "q4" }, deliver), true);
});

test("a poll starts one analysis, says analyzing while it runs and then has the sections", async () => {
  const analysis = deferred<AnalysisOutcome>();
  let cached = false;
  const { sections, analyses } = fixture({ read: () => cached ? { kind: "ok", file: file() } : { kind: "not_cached" },
    analyze: () => analysis.promise });
  assert.equal((await sections.poll(key)).status, "analyzing");
  assert.equal((await sections.poll({ ...key, path: "src/b.ts" })).status, "analyzing");
  assert.equal(analyses(), 1);
  cached = true;
  analysis.resolve("ok");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await sections.poll(key)).status, "ok");
});

test("a poll whose read missed just before the analysis finished still finds the sections", async () => {
  const analysis = deferred<AnalysisOutcome>();
  let cached = false;
  const { sections, analyses } = fixture({ analyze: () => analysis.promise, read: async (_query, call) => {
    if (call === 2) {
      cached = true;
      analysis.resolve("ok");
      await new Promise(resolve => setTimeout(resolve, 1));
      return { kind: "not_cached" };
    }
    return cached ? { kind: "ok", file: file() } : { kind: "not_cached" };
  } });
  assert.equal((await sections.poll(key)).status, "analyzing");
  assert.equal((await sections.poll(key)).status, "ok");
  assert.equal(analyses(), 1);
  const empty = fixture({ read: () => ({ kind: "not_cached" }), analyze: async () => "ok" });
  assert.equal((await empty.sections.poll(key)).status, "analyzing");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await empty.sections.poll(key)).status, "analysis_failed", "an analysis that left the file out failed");
});

test("a poll after a failed analysis says why until the memory of it lapses", async () => {
  let now = 1_000;
  const { sections, analyses } = fixture({ read: () => ({ kind: "not_cached" }),
    analyze: async () => "engine_unavailable", now: () => now });
  assert.equal((await sections.poll(key)).status, "analyzing");
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await sections.poll(key)).status, "engine_unavailable");
  assert.equal(analyses(), 1);
  now += 30_000;
  assert.equal((await sections.poll(key)).status, "analyzing", "a later poll tries again");
  assert.equal(analyses(), 2);
  assert.equal((await fixture({ bound: false }).sections.poll(key)).status, "not_bound");
});
