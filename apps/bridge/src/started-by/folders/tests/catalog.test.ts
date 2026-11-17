import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { scanSessionHistory, scanSessionHistoryForPaging } from "../../../sessions";
import { startedByPath, startedByState } from "../../links";
import { forgetRunFolders } from "..";
import { AT, BATCH_REQUEST, lessonartRows, ONE_REQUEST, writeCodexRun, writeTranscript } from "./lessonart";

const PARENT = "38034755-03a1-429d-8db6-2aa351e64a0b";

function roots(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "granttap-started-folders-"));
  const names = ["GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CODEX_SESSIONS_DIR", "GRANTTAP_CONFIG_DIR"] as const;
  const previous = names.map((name) => process.env[name]);
  const paths = { root, claude: join(root, "claude", "-Users-me-dev-lessons"), codex: join(root, "codex"),
    config: join(root, "config"), folder: join(root, "lessonart") };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = join(root, "claude");
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = paths.codex;
  process.env.GRANTTAP_CONFIG_DIR = paths.config;
  forgetRunFolders();
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    });
    rmSync(root, { recursive: true, force: true });
  });
  return paths;
}

test("a course's picture runs, started by scripts that read their requests from a file, hang beneath the chat that wrote them", (t) => {
  const paths = roots(t);
  const start = Date.now() - 5 * 60 * 60_000;
  writeTranscript(join(paths.claude, `${PARENT}.jsonl`), lessonartRows(paths.folder, start, PARENT));
  const run = (id: string, at: number, request = `${BATCH_REQUEST}\n\nImage 1: save to ${paths.folder}/png/u2-l1.png`,
    extra: { headless?: boolean; seconds?: number; cwd?: string } = {}) =>
    writeCodexRun(paths.codex, { id, at: start + at, cwd: paths.folder, request, ...extra });
  const children = [
    "01a1e7f0-0000-7000-8000-00000000pilot", "01a1e7f2-0000-7000-8000-0000detached",
    "01a1e7fc-0000-7000-8000-0000000nohup", "01a1e8a1-0000-7000-8000-0000000batch", "01a1e9cd-0000-7000-8000-0000000limit",
  ];
  run(children[0]!, AT.pilot + 1_500, `${ONE_REQUEST} ${paths.folder}/png/u1-l1.png. Prompt: a desk at dawn. Do not write code.`);
  run(children[1]!, AT.detached + 2_000, `${ONE_REQUEST} ${paths.folder}/png/u1-l7.png. Prompt: a harbour. Do not write code.`);
  run(children[2]!, AT.nohup + 30_000, `${ONE_REQUEST} ${paths.folder}/png/u3-l2.png. Prompt: a library. Do not write code.`);
  run(children[3]!, AT.grok + 5_000);
  run(children[4]!, 14_529_694, undefined, { seconds: 4 });
  // Not the chat's: a run before it first started Codex there, a person's own Codex chat in the folder,
  // and a run in a folder no chat named.
  run("01a1e7ef-0000-7000-8000-000000before", AT.pilot - 60_000);
  run("01a1e8a2-0000-7000-8000-0000000typed", AT.grok + 9_000, "Look at the pictures in this folder and tell me which are weak", { headless: false });
  run("01a1e8a3-0000-7000-8000-0000elsewhere", AT.grok + 9_000, undefined, { cwd: join(paths.root, "elsewhere") });

  const all = scanSessionHistoryForPaging().sessions;
  for (const id of children) {
    assert.deepEqual(all.find((session) => session.sessionId === id)?.startedBy, { agent: "claude", sessionId: PARENT }, id);
  }
  assert.deepEqual(all.filter((session) => session.startedBy).map((session) => session.sessionId).sort(), [...children].sort(),
    "no other chat gains a parent");
  assert.deepEqual([...startedByState().links.values()].map((link) => link.source), children.map(() => "transcript"));
  assert.equal(readFileSync(startedByPath(), "utf8").includes("lessonart"), false, "no folder or request is written down");

  // The catalog keeps the newest three as rows and counts every finished run on the chat that started them.
  const history = scanSessionHistory();
  const parent = history.find((session) => session.sessionId === PARENT);
  assert.equal(parent?.startedChildren?.finished, children.length);
  assert.equal(history.filter((session) => session.startedBy).length, 3);
});
