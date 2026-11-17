import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createClaudeLineageCalls, createCodexLineageCalls, type LineageFact } from "../../facts";
import { promptLead, type LineageAgent } from "../../headless";
import { FOLDER_WINDOW_MS, folderParents, forgetRunFolders, namedFolders, runFolder } from "..";
import { createFolderLaunches } from "../launches";
import { AT, BATCH_REQUEST, lessonartCommands, lessonartRows, ONE_REQUEST } from "./lessonart";

const F = "/tmp/lessonart-fixture";
const START = Date.parse("2026-11-17T09:56:50.169Z");
const NOW = START + 20 * 60 * 60_000;
const PARENT = "38034755-03a1-429d-8db6-2aa351e64a0b";
const yes = () => true;

function parent(sessionId = PARENT, folder = F): LineageFact {
  const calls = createClaudeLineageCalls();
  for (const row of lessonartRows(folder, START, sessionId)) calls.add(row);
  return { agent: "claude", sessionId, cwd: "/Users/me/dev/lessons", startedAt: START - 3_600_000,
    calls: calls.snapshot(), launches: calls.launches() };
}

function child(id: string, at: number, extra: Partial<LineageFact> = {}): LineageFact {
  return { agent: "codex", sessionId: id, cwd: F, startedAt: START + at, headless: true,
    prompt: promptLead(`${BATCH_REQUEST}\n\nImage 1: save to ${F}/png/u1.png`), ...extra };
}

test("a chat's folders are read from its commands: a script it wrote there, an argument list, a folder named again", () => {
  const { launches } = parent();
  const own = launches!.filter((launch) => launch.folder === F)
    .map((launch) => [launch.agent, launch.firstAt - START, launch.lastAt - START]);
  assert.deepEqual(own, [["codex", AT.pilot, AT.last], ["grok", AT.grok, AT.last]],
    "codex from the script it wrote, grok from its argument list; the last `ls` of the folder names it again");
  assert.ok(launches!.every((launch) => launch.folder.startsWith(F)), JSON.stringify(launches));

  assert.deepEqual(namedFolders(`cd /tmp/art && codex exec -C /tmp/art "save it to /tmp/art/cover.png."`), ["/tmp/art"]);
  assert.deepEqual(namedFolders(`out=/tmp/art/log/run-\${n}.log; cat "/private/tmp/art/one.sh"`), ["/tmp/art/log", "/tmp/art"]);
  assert.deepEqual(namedFolders(`cd ~/renders/run7 && ls $HOME/renders/run8/`, "/Users/me"),
    ["/Users/me/renders/run7", "/Users/me/renders/run8"]);
  assert.deepEqual(namedFolders(`cd /tmp && ls ~ /Users /usr/local/bin/codex /dev/null https://example.com/a/b ./x/y ../z/w`, "/Users/me"),
    [], "the temp directory, home and above, the system's folders, a URL and relative paths name no run's folder");
});

test("runs in the folder of a script written then run detached, and of a Python batch, are that chat's", () => {
  const facts = [parent()];
  const children = [
    child("pilot-run-000001", AT.pilot + 1_500, { prompt: promptLead(`${ONE_REQUEST} ${F}/png/u1-l1.png. Prompt: a desk`) }),
    child("detached-run-0001", AT.detached + 2_000),
    child("nohup-run-000001", AT.nohup + 30_000),
    child("batch-run-000001", AT.grok + 5_000),
    child("limit-run-000001", 14_529_694),
    child("grok-run-0000001", AT.grok + 3_000, { agent: "grok", cwd: `/private${F}` }),
  ];
  const parents = folderParents([...facts, ...children], NOW, yes);
  for (const item of children) {
    assert.deepEqual(parents(item), { agent: "claude", sessionId: PARENT }, item.sessionId);
  }
});

test("a folder two chats started runs in links nothing; a chat that only looks at it does not count", () => {
  const first = parent();
  const second = parent("second-chat-000001");
  const item = child("batch-run-000001", AT.grok + 5_000);
  assert.equal(folderParents([first, second, item], NOW, yes)(item), undefined);

  const looks = createClaudeLineageCalls();
  for (const [index, command] of [`ls ${F}/png | wc -l`, `pgrep -f "codex exec -C ${F}" | wc -l`, `tail ${F}/runner.out`].entries()) {
    looks.add({ type: "assistant", timestamp: new Date(START + AT.grok + index).toISOString(),
      message: { content: [{ type: "tool_use", id: `toolu_${index}`, name: "Bash", input: { command } }] } });
  }
  const watcher: LineageFact = { agent: "claude", sessionId: "watching-chat-0001", startedAt: START, launches: looks.launches() };
  assert.deepEqual(watcher.launches, []);
  assert.deepEqual(folderParents([first, watcher, item], NOW, yes)(item), { agent: "claude", sessionId: PARENT });
});

test("a run before the chat's first launch in its folder, or long after the chat last named it, is not linked", () => {
  const facts = [parent()];
  const at = (offset: number) => child(`run-at-${offset}`, offset);
  const parents = folderParents(facts, NOW + FOLDER_WINDOW_MS, yes);
  assert.equal(parents(at(AT.pilot - 4_000)), undefined, "before the first command that started codex there");
  assert.deepEqual(parents(at(AT.pilot - 2_000)), { agent: "claude", sessionId: PARENT }, "its record can trail the command by a moment");
  assert.deepEqual(parents(at(AT.last + FOLDER_WINDOW_MS - 1_000)), { agent: "claude", sessionId: PARENT });
  assert.equal(parents(at(AT.last + FOLDER_WINDOW_MS + 1_000)), undefined, "more than 12 hours after the chat last named the folder");
  const grok = child("grok-before-launch", AT.pilot + 60_000, { agent: "grok" });
  assert.equal(parents(grok), undefined, "a provider counts from the first command that started it there");
});

test("a person's session, another provider, another computer, another folder, or the chat itself is not linked", () => {
  const facts = [parent()];
  const parents = folderParents(facts, NOW, yes);
  const cases: Array<[string, LineageFact]> = [
    ["typed by a person", child("interactive-0001", AT.grok, { headless: false })],
    ["a provider never started there", child("claude-run-00001", AT.grok, { agent: "claude" })],
    ["another computer", child("elsewhere-000001", AT.grok, { computerId: "other-mac" })],
    ["a folder of its own", child("other-folder-001", AT.grok, { cwd: "/tmp/lessonart-fixture-2" })],
    ["a folder inside it the chat never named", child("subfolder-run-01", AT.grok, { cwd: `${F}/drafts` })],
    ["no folder", child("no-folder-run-01", AT.grok, { cwd: undefined })],
  ];
  for (const [label, item] of cases) assert.equal(parents(item), undefined, label);
  const self: LineageFact = { ...facts[0]!, agent: "codex", headless: true, cwd: F, startedAt: START + AT.grok,
    launches: [{ folder: F, agent: "codex", firstAt: START, lastAt: START + AT.last }] };
  assert.equal(folderParents([self], NOW, yes)(self), undefined, "a run never names itself");
  const younger = { ...facts[0]!, startedAt: START + AT.grok + 10_000 };
  assert.equal(folderParents([younger], NOW, yes)(child("older-run-000001", AT.grok)), undefined, "a parent exists before its child");
  assert.equal(folderParents([], NOW, yes)(child("alone-run-000001", AT.grok)), undefined);
});

function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "granttap-run-folders-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); forgetRunFolders(); });
  forgetRunFolders();
  return root;
}

test("a run's folder is one made for runs: no checkout of its own, in none, or gone", (t) => {
  const root = scratch(t);
  const plain = join(root, "lessonart");
  const checkout = join(root, "repo");
  const inside = join(checkout, "build", "art");
  for (const folder of [plain, join(checkout, ".git"), inside]) mkdirSync(folder, { recursive: true });
  assert.equal(runFolder(plain), true);
  assert.equal(runFolder(join(root, "gone-already")), true);
  assert.equal(runFolder(checkout), false, "a checkout of its own");
  assert.equal(runFolder(inside), false, "a folder inside a checkout");

  const facts = [parent(PARENT, checkout), parent("inside-chat-000001", inside)];
  const parents = folderParents(facts, NOW);
  assert.equal(parents(child("checkout-run-0001", AT.grok, { cwd: checkout })), undefined);
  assert.equal(parents(child("inside-run-000001", AT.grok, { cwd: inside })), undefined);
  assert.deepEqual(folderParents([parent(PARENT, plain)], NOW)(child("plain-run-000001", AT.grok, { cwd: plain })),
    { agent: "claude", sessionId: PARENT });

  // Asked once a minute: a folder that becomes a checkout is seen as one at the next look.
  mkdirSync(join(plain, ".git"));
  assert.equal(runFolder(plain, NOW + 30_000), true);
  assert.equal(runFolder(plain, NOW + 61_000), false);
});

test("a Codex chat's folders are read from its exec_command calls", () => {
  const calls = createCodexLineageCalls();
  const add = (at: number, id: string, cmd: string) => calls.add({ type: "response_item", timestamp: new Date(START + at).toISOString(),
    payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd }) } });
  add(0, "c1", `mkdir -p /tmp/codex-art && cat > /tmp/codex-art/run.sh <<'SH'\nclaude -p --cwd /tmp/codex-art "$(cat /tmp/codex-art/$1.txt)"\nSH`);
  add(60_000, "c2", "nohup /tmp/codex-art/run.sh 1 &");
  assert.deepEqual(calls.launches().map((launch) => [launch.agent, launch.folder, launch.lastAt - START]),
    [["claude", "/tmp/codex-art", 60_000]]);
});

test("a chat keeps at most 32 folders, letting go of the one it named longest ago", () => {
  const launches = createFolderLaunches();
  const targets: LineageAgent[] = ["codex"];
  launches.note("codex exec -C /tmp/batch-keep x", targets, 1);
  for (let index = 0; index < 40; index += 1) {
    launches.note(`codex exec -C /tmp/batch-${index} x`, targets, 10 + index);
    if (index % 8 === 0) launches.note("ls /tmp/batch-keep", [], 10 + index);
  }
  const kept = launches.snapshot();
  assert.equal(kept.length, 32);
  assert.ok(kept.some((launch) => launch.folder === "/tmp/batch-keep"), "a folder named again stays");
  assert.ok(!kept.some((launch) => launch.folder === "/tmp/batch-0"), "the folder named longest ago went first");
  launches.note("ls /tmp/nowhere", [], 99);
  assert.equal(launches.snapshot().length, 32);
});
