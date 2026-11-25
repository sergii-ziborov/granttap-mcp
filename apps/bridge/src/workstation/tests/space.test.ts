import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EngineWorkstationSpace } from "../../engine/protocol/engine-protocol";
import type { SpaceAnswer, WorkstationEngine } from "../engine";
import { readSpace, writeSpace } from "../settings";
import { agentDiskFromSpace, folderKind, fromEngine, scanSpace } from "../space";

const home = "/Users/me";

function engineSpace(): EngineWorkstationSpace {
  return {
    started_at_ms: 1_000, duration_ms: 31_000, complete: true, project_roots: 2,
    groups: [
      { id: "agent:codex", title: "Codex", section: "agents", bytes: 64_000, regenerable_bytes: 3_900, partial: false,
        items: [
          { title: "sessions", path: `${home}/.codex/sessions`, bytes: 19_000, kind: "history", partial: false },
          { title: "tmp", path: `${home}/.codex/tmp`, bytes: 3_900, kind: "regenerable", partial: true },
          { title: "odd", path: `${home}/.codex/odd`, bytes: 10, kind: "future-kind", partial: false },
        ] },
      { id: "future", title: "Future", section: "warp-drive", bytes: 5, regenerable_bytes: 0, partial: false, items: [] },
    ],
  };
}

function fakeEngine(answers: SpaceAnswer[]): WorkstationEngine & { calls: number } {
  const engine = {
    calls: 0,
    load: async () => undefined,
    supported: () => true,
    space: async () => { engine.calls += 1; return answers.shift() ?? "unavailable"; },
  };
  return engine;
}

test("an Engine summary reaches the phone with home-relative paths and only known sections and kinds", () => {
  const space = fromEngine(engineSpace(), "manual", home);
  assert.deepEqual(space.groups.map((group) => group.id), ["agent:codex"]);
  const [codex] = space.groups;
  assert.deepEqual(codex!.items.map((item) => [item.path, item.kind]), [
    ["~/.codex/sessions", "history"], ["~/.codex/tmp", "regenerable"], ["~/.codex/odd", "inspect"],
  ]);
  assert.equal(codex!.items[1]!.partial, true);
  assert.equal(space.source, "engine");
  assert.equal(space.trigger, "manual");
});

test("the load sheet's agent folders come from the summary, the rest folded into one line", () => {
  const disk = agentDiskFromSpace(fromEngine(engineSpace(), "daily", home));
  assert.deepEqual(Object.keys(disk), ["codex"]);
  assert.equal(disk.codex!.totalBytes, 64_000);
  assert.deepEqual(disk.codex!.entries.at(-1), { path: "…", bytes: 64_000 - 19_000 - 3_900 - 10 });
  assert.deepEqual(agentDiskFromSpace(undefined), {});
});

test("folder names measured with du are classified like the Engine does", () => {
  assert.equal(folderKind("~/.claude/projects"), "history");
  assert.equal(folderKind("~/.codex/archived_sessions"), "history");
  assert.equal(folderKind("~/.codex/tmp"), "regenerable");
  assert.equal(folderKind("~/Library/Caches/claude-cli-nodejs"), "regenerable");
  assert.equal(folderKind("~/.codex/state_5.sqlite"), "protected");
  assert.equal(folderKind("~/.claude/skills"), "context");
  assert.equal(folderKind("~/.codex/worktrees"), "inspect");
});

test("one measurement at a time; a busy Engine leaves the last summary standing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-ws-"));
  writeSpace(fromEngine(engineSpace(), "daily", home), directory);
  const engine = fakeEngine(["busy"]);
  const [first, second] = await Promise.all([
    scanSpace("manual", engine, { directory, home }), scanSpace("manual", engine, { directory, home }),
  ]);
  assert.equal(engine.calls, 1);
  assert.equal(first, second);
  assert.equal(first?.trigger, "daily");
});

test("an Engine summary is kept with the free space it saw", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-ws-"));
  const measured = await scanSpace("agent", fakeEngine([engineSpace()]), { directory, home: tmpdir() });
  assert.equal(measured?.trigger, "agent");
  assert.ok((measured?.diskAvailableBytes ?? 0) > 0);
  assert.deepEqual(readSpace(directory), measured);
});

test("without the Engine only the agents' folders are measured, with du", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-ws-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "gt-home-"));
  mkdirSync(join(fakeHome, ".codex", "sessions"), { recursive: true });
  writeFileSync(join(fakeHome, ".codex", "sessions", "rollout.jsonl"), Buffer.alloc(64_000, 1));
  const measured = await scanSpace("manual", fakeEngine(["unsupported"]), { directory, home: fakeHome });
  assert.equal(measured?.source, "folders");
  const codex = measured?.groups.find((group) => group.id === "agent:codex");
  assert.equal(codex?.items[0]?.kind, "history");
  assert.ok((codex?.bytes ?? 0) >= 64_000);
});
