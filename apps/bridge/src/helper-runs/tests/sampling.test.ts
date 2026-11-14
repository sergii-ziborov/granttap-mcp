import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetSessionResolver, sampleAgentProcesses } from "../../machine-load/host/process-sampler";
import { readProcessDirectories, resetHelperRunCapture } from "../capture";
import { helperRunFolder } from "../kinds";
import type { HelperRunLink } from "../links";

test("a load sample taken while a helper run is alive records the chat that started it", async (t) => {
  const config = mkdtempSync(join(tmpdir(), "granttap-helper-sample-"));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "hw-image-")));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = config;
  // Node asked to run `grok.js` is what the listing calls a Grok process.
  const script = join(config, "grok.js");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [script], {
    cwd: folder, stdio: "ignore",
    env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_SESSION_ID: "synthetic-parent-chat" },
  });
  const remembered: HelperRunLink[] = [];
  resetSessionResolver(async () => new Map());
  resetHelperRunCapture({ remember: (links) => { remembered.push(...links); return links.length; } });
  t.after(() => {
    child.kill("SIGKILL");
    resetSessionResolver();
    resetHelperRunCapture();
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(folder, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  if ((await readProcessDirectories([child.pid!])).size === 0) {
    return t.skip("this host has no tool that reports a process's working folder");
  }
  let load: Awaited<ReturnType<typeof sampleAgentProcesses>>;
  try { load = await sampleAgentProcesses(); }
  catch { return t.skip("the process listing is unavailable on this host right now"); }
  assert.ok((load.grok?.processes ?? 0) >= 1, "the stand-in is counted as a Grok process");
  const own = remembered.filter((link) => link.folder === helperRunFolder(folder)?.folder);
  assert.deepEqual(own.map((link) => [link.kind, link.parentAgent, link.parentSessionId]),
    [["image-generation", "claude", "synthetic-parent-chat"]]);
});
