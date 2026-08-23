import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function relayServer() {
  const server = createServer((_request, response) => {
    response.statusCode = 201;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function run(entry: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("source CLI connects, reuses, resets, and prints a recoverable paste URI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "granttap-cli-management-"));
  const desktop = join(root, "Desktop");
  const relay = await relayServer();
  t.after(() => relay.close());
  const env = {
    GRANTTAP_CONFIG_DIR: root,
    GRANTTAP_DESKTOP_DIR: desktop,
    GRANTTAP_SKIP_HOOKS: "1",
  };
  const connect = "apps/bridge/src/bin/connect.ts";
  const reset = "apps/bridge/src/bin/reset.ts";
  const pairUri = "apps/bridge/src/bin/pair-uri.ts";

  const help = await run(connect, ["--help"], env);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: granttap connect/);
  const invalid = await run(connect, ["--bad"], env);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Usage: granttap connect/);

  const first = await run(connect, ["--relay", relay.url], env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /one-time secure token/);
  assert.match(first.stdout, /Hooks: skipped/);
  const reused = await run(connect, ["--relay", relay.url], env);
  assert.equal(reused.code, 0, reused.stderr);
  assert.match(reused.stdout, /Existing pairing reused/);

  const resetHelp = await run(reset, ["--help"], env);
  assert.equal(resetHelp.code, 0);
  assert.match(resetHelp.stdout, /Usage: granttap reset/);
  const resetInvalid = await run(reset, ["--bad"], env);
  assert.equal(resetInvalid.code, 1);
  const declined = await run(reset, [], env);
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, /was not reset/);
  const accepted = await run(reset, ["--yes"], env);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.match(accepted.stdout, /pairing reset/);
  assert.equal((await readdir(root)).some((name) => name.includes(".reset-")), true);
  const empty = await run(reset, ["--yes"], env);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /already reset/);

  const uri = await run(pairUri, [relay.url], env);
  assert.equal(uri.code, 0, uri.stderr);
  assert.match(uri.stdout, /^granttap:\/\/pair-v2\?/);
  assert.match(uri.stderr, /GrantTap-pair-uri\.txt/);
  assert.equal((await readFile(join(desktop, "GrantTap-pair-uri.txt"), "utf8")).trim(), uri.stdout.trim());
});
