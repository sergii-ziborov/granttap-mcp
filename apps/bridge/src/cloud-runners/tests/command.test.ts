import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCloudCommand } from "../launch";

async function script(source: string): Promise<{ path: string; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "granttap-cloud-command-"));
  const path = join(cwd, "cli.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return { path, cwd };
}

test("the cloud CLI runs without a terminal or piped input, in the Task's checkout", async () => {
  const cli = await script([
    "let input = '';",
    "process.stdin.on('data', chunk => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), tty: !!process.stdout.isTTY, input }));",
    "  process.stderr.write('note');",
    "  process.exit(3);",
    "});",
  ].join("\n"));
  const output = await runCloudCommand({ binary: cli.path, args: ["--cloud", "Continue"], cwd: cli.cwd, timeoutMs: 10_000 });
  assert.equal(output.code, 3);
  assert.equal(output.stderr, "note");
  const seen = JSON.parse(output.stdout) as { args: string[]; cwd: string; tty: boolean; input: string };
  assert.deepEqual(seen.args, ["--cloud", "Continue"]);
  assert.equal(seen.tty, false);
  assert.equal(seen.input, "", "stdin is closed, so the CLI never takes piped input or waits for it");
});

test("a CLI that hangs is stopped, and a missing one is reported as not started", async () => {
  const hang = await script("setInterval(() => {}, 1_000);");
  const stopped = await runCloudCommand({ binary: hang.path, args: [], cwd: hang.cwd, timeoutMs: 200 });
  assert.equal(stopped.code, null);
  const missing = await runCloudCommand({ binary: join(hang.cwd, "missing"), args: [], cwd: hang.cwd, timeoutMs: 1_000 });
  assert.deepEqual(missing, { code: null, stdout: "", stderr: "" });
});
