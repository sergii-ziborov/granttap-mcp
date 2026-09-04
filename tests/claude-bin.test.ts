import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareVersions, explainClaudeFailure, installedClaudeBinaries, resolveClaudeBinary, versionOf,
} from "../apps/bridge/src/claude-bin";

function script(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho claude\n");
  chmodSync(path, 0o755);
}

async function mac(): Promise<{ home: string; bin: string }> {
  const home = await mkdtemp(join(tmpdir(), "granttap-claude-bin-"));
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  return { home, bin };
}

test("versions are read from paths and ordered numerically", () => {
  assert.equal(versionOf("2.1.260"), "2.1.260");
  assert.equal(versionOf("v2.1.9"), "2.1.9");
  assert.equal(versionOf("claude-2.1.9"), undefined, "only a bare version names an install");
  assert.equal(versionOf("MacOS"), undefined);
  assert.ok(compareVersions("2.1.260", "2.1.9") > 0, "260 is newer than 9, not older");
  assert.equal(compareVersions("2.1.260", "2.1.260"), 0);
});

test("the newest Claude Code on the Mac answers, wherever it was installed", async () => {
  const { home, bin } = await mac();
  // The native installer: PATH links to the version the user last updated to.
  script(join(home, ".local", "share", "claude", "versions", "2.1.201"));
  script(join(home, ".local", "share", "claude", "versions", "2.1.138"));
  symlinkSync(join(home, ".local", "share", "claude", "versions", "2.1.201"), join(bin, "claude"));
  // The desktop app: its own copies, one of them newer than PATH's.
  const app = join(home, "Library", "Application Support", "Claude", "claude-code");
  script(join(app, "2.1.260", "claude.app", "Contents", "MacOS", "claude"));
  script(join(app, "2.1.247", "claude.app", "Contents", "MacOS", "claude"));
  mkdirSync(join(app, "not-a-version"), { recursive: true });

  const env = { PATH: bin };
  const found = installedClaudeBinaries(home, env);
  assert.deepEqual(found.map((item) => item.version), ["2.1.260", "2.1.247", "2.1.201", "2.1.201", "2.1.138"]);
  assert.equal(found[0]?.path, join(app, "2.1.260", "claude.app", "Contents", "MacOS", "claude"));
  assert.equal(resolveClaudeBinary(home, env).version, "2.1.260");

  // PATH's claude is the newest once the user has run `claude update`.
  script(join(home, ".local", "share", "claude", "versions", "2.1.300"));
  assert.equal(resolveClaudeBinary(home, env).version, "2.1.300");

  // An explicit override is never second-guessed, even without a version.
  const override = join(home, "my-claude");
  script(override);
  assert.deepEqual(resolveClaudeBinary(home, { ...env, GRANTTAP_CLAUDE_BIN: override }), { path: override });
});

test("with nothing installed, plain `claude` is left for PATH to resolve", async () => {
  const { home, bin } = await mac();
  assert.deepEqual(resolveClaudeBinary(home, { PATH: bin }), { path: "claude" });
  // A PATH claude that carries no version is still used, after any versioned copy.
  script(join(bin, "claude"));
  assert.deepEqual(resolveClaudeBinary(home, { PATH: bin }), { path: join(bin, "claude") });
});

test("an outdated Claude Code's refusal names the version that answered and the way out", () => {
  const binary = { path: "/Users/me/.local/bin/claude", version: "2.1.201" };
  const explained = explainClaudeFailure(
    "API Error: 400 Claude Code 2.1.201 does not support model version 2.1.251", binary,
  );
  assert.match(explained, /Claude Code 2\.1\.201 at \/Users\/me\/\.local\/bin\/claude is older/);
  assert.match(explained, /claude update/);
  assert.match(explainClaudeFailure("outdated", { path: "claude" }), /This Claude Code at claude/);
  assert.equal(explainClaudeFailure("Tool refused", binary), "Tool refused", "other failures pass through");
});
