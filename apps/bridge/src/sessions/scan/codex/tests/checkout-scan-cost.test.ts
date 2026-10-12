import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanCodex } from "..";

test("one catalog scan verifies each repeated checkout once and rechecks on the next scan", t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-checkout-scan-"));
  const original = join(root, "original"), observed = join(root, "observed");
  const logs = join(root, "logs"), bin = join(root, "bin"), calls = join(root, "calls");
  for (const path of [original, observed, logs, bin]) mkdirSync(path);
  for (const path of [original, observed]) execFileSync("/usr/bin/git", ["init", "-q", path]);
  const prior = { path: process.env.PATH, logs: process.env.GRANTTAP_CODEX_SESSIONS_DIR };
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf x >> '${calls}'\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${prior.path}`;
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = logs;
  t.after(() => {
    process.env.PATH = prior.path;
    if (prior.logs === undefined) delete process.env.GRANTTAP_CODEX_SESSIONS_DIR;
    else process.env.GRANTTAP_CODEX_SESSIONS_DIR = prior.logs;
    rmSync(root, { recursive: true, force: true });
  });
  const writeLogs = (revision: number) => {
    for (let i = 0; i < 3; i++) {
      const rows = [{ type: "session_meta", payload: { id: `fixture-${i}`, cwd: original } },
        ...Array.from({ length: 3 }, (_, j) => ({ type: "response_item", payload: {
          type: "function_call", name: "exec_command", call_id: `call-${revision}-${j}`,
          arguments: JSON.stringify({ cmd: "pwd", workdir: observed }),
        } }))];
      writeFileSync(join(logs, `rollout-${i}.jsonl`), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    }
  };
  writeLogs(0);
  const first = scanCodex(3).sessions;
  assert.equal(first.length, 3);
  assert.ok(first.every(s => s.worktree === realpathSync(observed)));
  assert.equal(readFileSync(calls, "utf8").length, 2,
    "Repeated execution logs must not spawn duplicate Git verification processes.");
  writeLogs(1);
  scanCodex(3);
  assert.equal(readFileSync(calls, "utf8").length, 4,
    "A new scan must verify current repository identity rather than trust an old cache.");
});
