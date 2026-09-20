import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveCodexBinary } from "../../apps/bridge/src/providers/codex-bin";

test("background Codex delivery finds the desktop CLI outside launchd PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-bin-"));
  const bundled = join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
  await mkdir(dirname(bundled), { recursive: true });
  await writeFile(bundled, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  assert.equal(resolveCodexBinary(root, { PATH: "/usr/bin:/bin" }, join(root, "Applications")), bundled);
});

test("explicit Codex binary wins over the desktop bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-override-"));
  const bundled = join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
  await mkdir(dirname(bundled), { recursive: true });
  await writeFile(bundled, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  assert.equal(resolveCodexBinary(root, {
    PATH: "/usr/bin:/bin", GRANTTAP_CODEX_BIN: "/custom/codex",
  }, join(root, "Applications")), "/custom/codex");
});

test("a Codex CLI on PATH keeps priority over the desktop bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "granttap-codex-path-"));
  const onPath = join(root, "bin", "codex");
  const bundled = join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
  for (const path of [onPath, bundled]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  assert.equal(resolveCodexBinary(root, { PATH: dirname(onPath) }, join(root, "Applications")), onPath);
});
