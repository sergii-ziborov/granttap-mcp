import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { createHeadlessRunWatch, providerTranscriptRoots, watchHeadlessRuns, type TranscriptRoot } from "..";
import { folder, heardWithin } from "./streams";

const NOW = 1_800_000_000_000;
/** Any folder that is there: the harness hears nothing from it but what a test sends. */
const CODEX = tmpdir();

/** A watch whose file events a test sends by hand. */
function harness(input: { born?: Map<string, number>; sample?: () => Promise<unknown>; roots?: TranscriptRoot[] } = {}) {
  const listeners = new Map<string, (event: string, name: string | null) => void>();
  const failures = new Map<string, () => void>();
  const closed: string[] = [];
  let samples = 0;
  const born = input.born ?? new Map<string, number>();
  const watch = createHeadlessRunWatch({
    sample: input.sample ?? (async () => { samples += 1; }),
    roots: () => input.roots ?? [{ root: CODEX, transcript: (name) => /(?:^|\/)rollout-[^/]+\.jsonl$/.test(name) }],
    watch: (root, changed, failed) => {
      listeners.set(root, changed); failures.set(root, failed);
      return { close: () => { closed.push(root); } };
    },
    bornAt: (path) => born.get(path),
    now: () => NOW,
  });
  const send = (event: string, name: string | null, root = CODEX) => listeners.get(root)?.(event, name);
  return { watch, send, born, closed, failures, samples: () => samples };
}

test("a new transcript asks for one sample at once; other files, old ones and repeats do not", async () => {
  const run = "2026/11/17/rollout-2026-11-17T12-11-29-01a1e8fd.jsonl";
  const { watch, send, born, samples } = harness();
  born.set(`${CODEX}/${run}`, NOW - 800);
  born.set(`${CODEX}/2026/11/17/rollout-old.jsonl`, NOW - 3_600_000);
  watch.start();
  send("rename", run);
  await watch.settled();
  assert.equal(samples(), 1);
  for (const [event, name] of [["change", run], ["rename", run], ["rename", "2026/11/17/notes.txt"], ["rename", null],
    ["rename", "2026/11/17/rollout-old.jsonl"], ["rename", "2026/11/17/rollout-gone.jsonl"]] as const) send(event, name);
  await watch.settled();
  assert.equal(samples(), 1, "a change to it, the same name again, another file, an old transcript moved, or one already gone");
});

test("transcripts that appear while a sample runs ask for one more after it, however many they are", async () => {
  let release!: () => void;
  let samples = 0;
  const { watch, send, born } = harness({ sample: () => { samples += 1; return new Promise<void>((resolve) => { release = resolve; }); } });
  const names = Array.from({ length: 6 }, (_, index) => `2026/11/17/rollout-run-${index}.jsonl`);
  for (const name of names) born.set(`${CODEX}/${name}`, NOW - 500);
  watch.start();
  send("rename", names[0]!);
  for (const name of names.slice(1)) send("rename", name);
  assert.equal(samples, 1, "five more arrived during the first");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(samples, 2);
  release();
  await watch.settled();
  assert.equal(samples, 2, "and nothing after that until another transcript");
});

test("a failing sample is not thrown; a stopped watch closes its folders and hears nothing", async () => {
  const { watch, send, born, closed, failures } = harness({ sample: async () => { throw new Error("process listing unavailable"); } });
  born.set(`${CODEX}/rollout-a.jsonl`, NOW);
  watch.start();
  send("rename", "rollout-a.jsonl");
  await watch.settled();
  watch.stop();
  assert.deepEqual(closed, [CODEX]);
  assert.deepEqual(watch.watching(), []);
  send("rename", "rollout-b.jsonl");
  watch.start();
  assert.deepEqual(watch.watching(), [CODEX], "a monitor that leads again watches again");
  failures.get(CODEX)!();
  assert.deepEqual(watch.watching(), [], "a watch that stopped by itself is let go");
  watch.start();
  assert.deepEqual(watch.watching(), [CODEX], "and taken up at the next start");
});

test("each provider's new transcripts are told from its other files", () => {
  const roots = providerTranscriptRoots();
  const [codex, claude, grok] = roots.map((root) => root.transcript);
  assert.equal(codex!("2026/11/17/rollout-2026-11-17T12-11-29-01a1e8fd-68f3-7b32-bfe1-c12157cdb0c2.jsonl"), true);
  assert.equal(codex!("2026/11/17/notes.jsonl"), false);
  assert.equal(claude!("-Users-me-dev-app/5b0e6c1e-parent-0000-0000-000000000001.jsonl"), true);
  assert.equal(claude!("-Users-me-dev-app/5b0e6c1e-parent/subagents/agent-a1.jsonl"), false, "a subagent's log is no new chat");
  assert.equal(grok!("%2Fprivate%2Ftmp%2Flessonart/01a1e93c-f245-7631-bf97-613fe65959d3/chat_history.jsonl"), true);
  assert.equal(grok!("%2Fprivate%2Ftmp%2Flessonart/01a1e93c-f245-7631-bf97-613fe65959d3/events.jsonl"), false);
  const elsewhere = watchHeadlessRuns(async () => undefined, "linux");
  elsewhere.start();
  assert.deepEqual(elsewhere.watching(), [], "only macOS watches a folder tree in one stream");
});

test("a rollout written to a watched folder is heard within moments", { skip: process.platform !== "darwin" }, async (t) => {
  const root = folder(t);
  let samples = 0;
  const watch = createHeadlessRunWatch({ sample: async () => { samples += 1; },
    roots: () => [{ ...providerTranscriptRoots()[0]!, root }] });
  watch.start();
  t.after(() => watch.stop());
  assert.ok(await heardWithin(root, () => samples, 5_000) < 200);
});
