import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { captureStartedRunsNow } from "../../../machine-load/host/process-sampler";
import { readProcessDirectories } from "../../../helper-runs/capture";
import { plainFolder } from "../../../helper-runs/kinds";
import { scanSessions } from "../../../sessions";
import { resetStartedRunCapture } from "../../capture";
import { startedByState } from "../../links";
import { createHeadlessRunWatch, providerTranscriptRoots } from "..";
import { folder, heardWithin } from "./streams";

const PARENT = "38034755-03a1-429d-8db6-2aa351e64a0b";
const RUN = "01a1e9cd-c814-7620-a609-026e64cd3e05";
const LIFE_MS = 1_600;

/**
 * A stand-in for `codex exec` that a usage limit stops: it writes its rollout 0.4 s in and is gone at
 * 1.6 s, before a sample every two seconds could be sure to see it.
 */
const FAKE_CODEX = `const fs = require("fs"), path = require("path");
fs.writeFileSync(process.env.RUN_PID_FILE, String(process.pid));
setTimeout(() => {
  const at = new Date().toISOString();
  const day = path.join(process.env.RUN_SESSIONS, ...at.slice(0, 10).split("-"));
  fs.mkdirSync(day, { recursive: true });
  const meta = { id: process.env.RUN_ID, timestamp: at, cwd: process.argv[process.argv.indexOf("-C") + 1], originator: "codex_exec", source: "exec" };
  fs.writeFileSync(path.join(day, "rollout-" + at.slice(0, 19).replace(/:/g, "-") + "-" + process.env.RUN_ID + ".jsonl"),
    JSON.stringify({ type: "session_meta", timestamp: at, payload: meta }) + "\\n"
    + JSON.stringify({ type: "response_item", timestamp: at, payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: process.argv.at(-1) }] } }) + "\\n");
}, 400);
setTimeout(() => process.exit(0), ${LIFE_MS});
`;

function environment(t: TestContext, root: string) {
  const paths = { codex: join(root, "codex"), claude: join(root, "claude"), config: join(root, "config"),
    work: join(root, "lessonart"), bin: join(root, "bin") };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const names = ["GRANTTAP_CODEX_SESSIONS_DIR", "GRANTTAP_CLAUDE_PROJECTS_DIR", "GRANTTAP_CONFIG_DIR"] as const;
  const previous = names.map((name) => process.env[name]);
  process.env.GRANTTAP_CODEX_SESSIONS_DIR = paths.codex;
  process.env.GRANTTAP_CLAUDE_PROJECTS_DIR = paths.claude;
  process.env.GRANTTAP_CONFIG_DIR = paths.config;
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
  }));
  writeFileSync(join(paths.bin, "codex"), FAKE_CODEX);
  chmodSync(join(paths.bin, "codex"), 0o755);
  return paths;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a run that lives under two seconds is caught while it lives, and its session names the chat that started it",
  { skip: process.platform !== "darwin" }, async (t) => {
    const paths = environment(t, folder(t));
    const pidFile = join(paths.bin, "run.pid");
    const runPid = () => existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : -1;
    // The run's own environment carries no chat's id: a monitor already running on this computer must not
    // take this test's run for a chat's. The test reads it as if it carried this one.
    resetStartedRunCapture({ readers: { directories: readProcessDirectories,
      variables: async (pids) => new Map(pids.filter((pid) => pid === runPid()).map((pid) => [pid, { claude: PARENT }])) } });
    t.after(() => resetStartedRunCapture());
    let samples = 0;
    const watch = createHeadlessRunWatch({ sample: async () => { samples += 1; await captureStartedRunsNow(); },
      roots: () => [{ ...providerTranscriptRoots()[0]!, root: paths.codex }] });
    watch.start();
    t.after(() => watch.stop());
    await heardWithin(paths.codex, () => samples, 5_000);
    await watch.settled();

    const started = Date.now();
    // Started through a shell that exits at once, as `nohup … & disown` leaves a batch: no provider above it.
    spawn("/bin/sh", ["-c", `"${process.execPath}" "${join(paths.bin, "codex")}" exec --skip-git-repo-check -C "${paths.work}" `
      + `"Use your image_gen tool to generate exactly one landscape image of a lighthouse" > /dev/null 2>&1 &`], {
      stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? paths.bin,
        RUN_PID_FILE: pidFile, RUN_SESSIONS: paths.codex, RUN_ID: RUN },
    });
    for (let waited = 0; waited < 5_000; waited += 50) {
      const pid = runPid();
      if (pid > 0) { try { process.kill(pid, 0); } catch { break; } }
      await sleep(50);
    }
    const lived = Date.now() - started;
    await watch.settled();
    assert.ok(lived < 2_500, `the run lived ${lived} ms`);

    const run = startedByState().runs.find((item) => item.pid === runPid());
    assert.deepEqual(run && { agent: run.agent, folder: plainFolder(run.folder!), parent: run.parent },
      { agent: "codex", folder: plainFolder(paths.work), parent: { agent: "claude", sessionId: PARENT } },
      "its transcript asked for a sample while its process lived");
    const child = scanSessions().sessions.find((session) => session.sessionId === RUN);
    assert.deepEqual(child?.startedBy, { agent: "claude", sessionId: PARENT });
    assert.equal([...startedByState().links.values()].find((link) => link.sessionId === RUN)?.source, "process");
  });
