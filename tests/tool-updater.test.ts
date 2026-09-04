import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeCommand, inspectTool, installMethod, manualHint, updateArgv, updateTool, updatingTools,
} from "../apps/bridge/src/tools/updater";
import {
  askVersion, binaryVersion, forgetVersion, parseVersionOutput, stripAnsi, versionFromLayout, versionFromPackage,
} from "../apps/bridge/src/tools/version";
import { handleToolUpdate } from "../apps/bridge/src/tools/update-handler";

const ESC = String.fromCharCode(27);

/**
 * A fake tool: `--version` prints the sidecar, `update` bumps it and touches
 * itself, and — when the tool lives in an npm package — rewrites the manifest
 * the way `npm install -g` would.
 */
function tool(path: string, version: string, updateTo?: string, exitCode = 0): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const sidecar = `${path}.version`;
  writeFileSync(sidecar, version);
  const manifest = packageManifest(path);
  if (manifest) writeFileSync(manifest, JSON.stringify({ version }));
  const bump = updateTo
    ? `printf '${updateTo}' > '${sidecar}'; touch "$0"; ${manifest ? `printf '{"version":"${updateTo}"}' > '${manifest}';` : ""}`
    : "";
  writeFileSync(path, [
    "#!/bin/sh",
    'case "$1" in',
    `  --version) echo "tool $(cat '${sidecar}') (build)";;`,
    `  update) echo "updating..."; ${bump} exit ${exitCode};;`,
    "esac",
  ].join("\n"));
  chmodSync(path, 0o755);
}

function packageManifest(path: string): string | undefined {
  const at = path.indexOf("/node_modules/");
  if (at < 0) return undefined;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const dir = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return join(path.slice(0, at + "/node_modules/".length), ...dir, "package.json");
}

async function mac(): Promise<{ home: string; bin: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(join(tmpdir(), "granttap-updater-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  forgetVersion();
  return { home, bin, env: { PATH: bin, HOME: home } };
}

test("an install method is read from the path, and only a stated layout carries a version", () => {
  assert.deepEqual(installMethod("/Users/me/.nvm/versions/node/v22.13.1/lib/node_modules/@openai/codex/bin/codex.js"), {
    method: "npm", npmPrefix: "/Users/me/.nvm/versions/node/v22.13.1", npmPackage: "@openai/codex",
  });
  assert.deepEqual(installMethod("/opt/homebrew/lib/node_modules/@xai-official/grok/bin/grok"), {
    method: "npm", npmPrefix: "/opt/homebrew", npmPackage: "@xai-official/grok",
  });
  assert.equal(installMethod("/opt/homebrew/Caskroom/codex/0.9.0/codex").method, "brew");
  assert.equal(installMethod("/Users/me/.local/share/claude/versions/2.1.260").method, "native");
  assert.equal(installMethod("/Users/me/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude").method, "desktop");
  assert.equal(installMethod("/usr/local/bin/codex").method, "unknown");

  assert.equal(versionFromLayout("/Users/me/.local/share/claude/versions/2.1.260"), "2.1.260");
  assert.equal(versionFromLayout("/Users/me/Library/Application Support/Claude/claude-code/2.1.247/claude.app/Contents/MacOS/claude"), "2.1.247");
  assert.equal(versionFromLayout("/Users/me/.nvm/versions/node/v22.13.1/bin/grok"), undefined, "nvm's node version is not the tool's");
  assert.equal(versionFromLayout("/Users/me/.local/share/cursor-agent/versions/2026.09.01-4852336/cursor-agent"), "2026.09.01-4852336");
  assert.equal(versionFromLayout("/opt/homebrew/Caskroom/codex/0.9.0/codex"), "0.9.0");
  assert.equal(versionFromPackage("/usr/local/bin/codex"), undefined);
  assert.equal(parseVersionOutput(stripAnsi(`${ESC}[1mgrok 1.0.0${ESC}[0m (3cd0d0c)`)), "1.0.0");
  assert.equal(parseVersionOutput("no digits here"), undefined);
});

test("each tool gets its own updater, and a script-installed Codex is left to a trusted terminal", async () => {
  const { home, bin, env } = await mac();
  tool(join(home, ".local", "share", "claude", "versions", "2.1.201"), "2.1.201");
  symlinkSync(join(home, ".local", "share", "claude", "versions", "2.1.201"), join(bin, "claude"));
  tool(join(home, ".local", "share", "cursor-agent", "versions", "2026.9.1", "cursor-agent"), "2026.9.1");
  symlinkSync(join(home, ".local", "share", "cursor-agent", "versions", "2026.9.1", "cursor-agent"), join(bin, "cursor-agent"));
  tool(join(bin, "grok"), "1.0.0");
  // Codex from npm: the npm that owns the prefix runs the update.
  mkdirSync(join(home, "npm-prefix"), { recursive: true });
  // The prefix is read back from the resolved executable, so compare resolved.
  const prefix = realpathSync(join(home, "npm-prefix"));
  tool(join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), "0.8.0");
  tool(join(prefix, "bin", "npm"), "10.0.0");
  symlinkSync(join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), join(bin, "codex"));

  const cursorEnv = { ...env, GRANTTAP_CURSOR_AGENT_BIN: join(bin, "cursor-agent") };
  const claude = inspectTool("claude", cursorEnv, home);
  assert.equal(claude.version, "2.1.201");
  assert.deepEqual(claude.update, [join(bin, "claude"), "update"]);
  assert.equal(describeCommand(claude.update!), "claude update");

  const codex = inspectTool("codex", env, home);
  assert.equal(codex.method, "npm");
  assert.deepEqual(codex.update, [join(prefix, "bin", "npm"), "install", "-g", "@openai/codex@latest"]);
  assert.equal(codex.version, "0.8.0");

  const cursor = inspectTool("cursor", cursorEnv, home);
  assert.deepEqual(cursor.update, [join(bin, "cursor-agent"), "update"]);
  assert.equal(cursor.version, "2026.9.1");
  const grok = inspectTool("grok", env, home);
  assert.deepEqual(grok.update, [join(bin, "grok"), "update"]);
  assert.equal(grok.version, undefined, "a tool nothing states a version for is never run to find out");

  // Brew and desktop copies, and a Codex nobody can update from here.
  assert.equal(updateArgv("claude", "/opt/homebrew/bin/claude", { method: "brew" }, { PATH: bin }), undefined, "no brew on this PATH");
  tool(join(bin, "brew"), "4.0.0");
  assert.deepEqual(updateArgv("codex", "/opt/homebrew/bin/codex", { method: "brew" }, { PATH: bin }), [join(bin, "brew"), "upgrade", "--cask", "codex"]);
  assert.deepEqual(updateArgv("claude", "/opt/homebrew/bin/claude", { method: "brew" }, { PATH: bin }), [join(bin, "brew"), "upgrade", "--cask", "claude-code"]);
  assert.equal(updateArgv("claude", "/x/claude", { method: "desktop" }, env), undefined);
  assert.equal(updateArgv("codex", "/usr/local/bin/codex", { method: "unknown" }, env), undefined);
  assert.equal(updateArgv("claude", "/x/claude", { method: "npm", npmPrefix: join(home, "nowhere") }, { PATH: join(home, "empty") }), undefined, "no npm anywhere");
  assert.match(manualHint("codex", { agent: "codex", path: "/usr/local/bin/codex", method: "unknown" }), /trusted terminal.*install\.sh/);
  assert.match(manualHint("claude", { agent: "claude", path: "/x", method: "desktop" }), /keeps it current/);
  assert.match(manualHint("grok", { agent: "grok", method: "unknown" }), /not installed/);
  assert.match(manualHint("cursor", { agent: "cursor", path: "/x", method: "unknown" }), /trusted terminal/);
});

test("the newest Claude Code on the disk answers, and the CLI knows it is behind", async () => {
  const { home, bin, env } = await mac();
  tool(join(home, ".local", "share", "claude", "versions", "2.1.201"), "2.1.201");
  symlinkSync(join(home, ".local", "share", "claude", "versions", "2.1.201"), join(bin, "claude"));
  const app = join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.260", "claude.app", "Contents", "MacOS", "claude");
  tool(app, "2.1.260");
  const status = inspectTool("claude", env, home);
  assert.equal(status.version, "2.1.260", "what answers the phone");
  assert.equal(status.newerOnThisMac, "2.1.260");
  assert.deepEqual(status.update, [join(bin, "claude"), "update"], "and `claude update` still repairs the CLI itself");
});

test("an update runs the tool's own updater once, reports before and after, and never twice at once", async () => {
  const { home, bin, env } = await mac();
  const grokPackage = join(realpathSync(home), "node_modules", "@xai-official", "grok", "bin", "grok");
  tool(grokPackage, "1.0.0", "1.1.0");
  symlinkSync(grokPackage, join(bin, "grok"));
  const first = updateTool("grok", env, home);
  assert.deepEqual(updatingTools(), ["grok"]);
  const second = await updateTool("grok", env, home);
  assert.equal(second.ok, false);
  assert.match(second.message, /already being updated/);
  const outcome = await first;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.before, "1.0.0");
  assert.equal(outcome.after, "1.1.0");
  assert.equal(outcome.command, "grok update");
  assert.match(outcome.message, /updated from 1\.0\.0 to 1\.1\.0/);
  assert.match(outcome.output ?? "", /updating/);
  assert.deepEqual(updatingTools(), []);

  // Already current: same version before and after.
  const same = await updateTool("grok", env, home);
  assert.equal(same.ok, true);
  assert.match(same.message, /up to date \(1\.1\.0\)/);

  // A failing updater says so, with its output kept.
  tool(join(bin, "cursor-agent"), "1.0.0", undefined, 3);
  const failed = await updateTool("cursor", { ...env, GRANTTAP_CURSOR_AGENT_BIN: join(bin, "cursor-agent") }, home);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /exited with code 3/);
  assert.equal(failed.before, undefined, "nothing stated a version, and nothing was run to find one");
  assert.equal(failed.after, "1.0.0", "asked only once its own updater had already run it");

  // Nothing to run: the reason comes back instead of a command.
  const missing = await updateTool("codex", env, home);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /not installed/);

  // A runner that cannot start, or does not finish, is reported the same way.
  const stuck = await updateTool("grok", env, home, async () => ({ code: null, output: "", error: "did not finish within 10 minutes" }));
  assert.match(stuck.message, /did not finish/);
});

test("a version is asked once and again only after the binary changes", async () => {
  const { bin } = await mac();
  tool(join(bin, "grok"), "1.0.0");
  let asked = 0;
  const probe = (): string => { asked += 1; return "9.9.9"; };
  assert.equal(binaryVersion(join(bin, "grok"), probe), "9.9.9");
  assert.equal(binaryVersion(join(bin, "grok"), probe), "9.9.9");
  assert.equal(asked, 1);
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(bin, "grok"), later, later);
  binaryVersion(join(bin, "grok"), probe);
  assert.equal(asked, 2);
  forgetVersion(join(bin, "grok"));
  binaryVersion(join(bin, "grok"), probe);
  assert.equal(asked, 3);
  forgetVersion(join(bin, "missing"));
  assert.equal(binaryVersion(join(bin, "missing"), probe), undefined);
  assert.equal(binaryVersion(join(bin, "grok")), undefined, "without a probe nothing is run");
  assert.equal(askVersion(join(bin, "grok")), "1.0.0", "asking reads --version");
  assert.equal(askVersion(join(bin, "nothing-here")), undefined);
});

test("the phone's request is answered with what the updater did", async () => {
  const sent: unknown[] = [];
  await handleToolUpdate(
    async (result) => { sent.push(result); },
    { type: "tool.update", agent: "claude", requestId: "r1", createdAt: 1 },
    async () => ({
      ok: true, before: "2.1.201", after: "2.1.260", command: "claude update",
      message: "Claude Code updated from 2.1.201 to 2.1.260.", output: "ok",
    }),
  );
  assert.equal(sent.length, 1);
  const result = sent[0] as Record<string, unknown>;
  assert.equal(result.type, "tool.update.result");
  assert.equal(result.requestId, "r1");
  assert.equal(result.after, "2.1.260");
  assert.equal(result.ok, true);
});
