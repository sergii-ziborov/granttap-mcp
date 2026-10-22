import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownedHookCommands } from "../../../../bridge/src/codex-hook-trust";
import { startHttpMcpServer } from "../http-server";

test("desktop discovery returns observations without starting a provider CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "granttap-desktop-discovery-"));
  const binary = join(directory, "codex");
  const marker = join(directory, "provider-started");
  await writeFile(binary, `#!/bin/sh\n: > '${marker}'\nexit 0\n`, { mode: 0o700 });
  const config = `[[hooks.PreToolUse]]\nmatcher = ".*"\n[[hooks.PreToolUse.hooks]]\n` +
    `type = "command"\ncommand = '${ownedHookCommands().policy}'\ntimeout = 30\n`;
  await writeFile(join(directory, "config.toml"), config);
  const overrides = { GRANTTAP_CONFIG_DIR: directory, GRANTTAP_CODEX_DIR: directory,
    GRANTTAP_CODEX_BIN: binary };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const runtime = await startHttpMcpServer({ host: "127.0.0.1", port });
  t.after(() => runtime.close());
  for (let check = 0; check < 2; check++) {
    const response = await fetch(`http://127.0.0.1:${port}/desktop/status`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const status = await response.json() as Record<string, unknown>;
    assert.equal(status.schema, "granttap.desktop-status.v1");
    assert.equal(status.ok, true);
    assert.ok(Array.isArray(status.providers));
    assert.equal(typeof status.desktopEngineSocket, "string");
    assert.equal(existsSync(marker), false, "Opening the Mac app must not start Codex or initialize its state");
  }
});
