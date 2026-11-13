import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readNativeCredential, readNativeKeychain } from "../credentials";

test("only existing provider credentials are read; relocated profiles cannot fall through to a different account", async () => {
  const home = await mkdtemp(join(tmpdir(), "granttap-native-credentials-"));
  const calls: string[] = [];
  const keychain = async (service: string, account?: string) => {
    calls.push(`${service}:${account ?? ""}`);
    return service.startsWith("Claude") ? JSON.stringify({ claudeAiOauth: { accessToken: "claude-secret" } }) : "cursor-secret";
  };
  const options = { home, env: {}, platform: "darwin" as const, keychain, now: 100 };
  const save = async (file: string, data: unknown) => {
    await mkdir(join(home, file, ".."), { recursive: true });
    await writeFile(join(home, file), JSON.stringify(data));
  };
  try {
    assert.equal(await readNativeCredential("claude", options), undefined);
    assert.equal(await readNativeCredential("cursor", options), undefined);
    assert.deepEqual(calls, []);
    await save(".claude/settings.json", {});
    await save(".cursor/cli-config.json", {});
    assert.equal(await readNativeCredential("claude", options), "claude-secret");
    assert.equal(await readNativeCredential("cursor", options), "cursor-secret");
    assert.deepEqual(calls, ["Claude Code-credentials:", "cursor-access-token:cursor-user"]);
    await save(".claude/.credentials.json", { claudeAiOauth: { accessToken: "file-claude", expiresAt: 200 } });
    await save(".cursor/auth.json", { accessToken: "file-cursor" });
    assert.equal(await readNativeCredential("claude", options), "file-claude");
    assert.equal(await readNativeCredential("cursor", options), "file-cursor");
    assert.equal(await readNativeCredential("claude", { ...options, env: { CLAUDE_CONFIG_DIR: join(home, "other") } }), undefined);
    await save(".grok/auth.json", { "https://other.example::id": { auth_mode: "oidc", key: "wrong" },
      "https://auth.x.ai::id": { auth_mode: "oidc", key: "grok-secret", refresh_token: "never-return" } });
    assert.equal(await readNativeCredential("grok", options), "grok-secret");
    assert.equal(await readNativeCredential("grok", { ...options, env: { GRANTTAP_GROK_DIR: join(home, "other") } }), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("missing, expired, malformed and oversized credentials never start authentication", async () => {
  const home = await mkdtemp(join(tmpdir(), "granttap-native-invalid-"));
  const options = { home, env: {}, platform: "linux" as const, now: 100 };
  try {
    await mkdir(join(home, ".claude"));
    for (const value of [{}, { claudeAiOauth: { accessToken: "expired", expiresAt: 50 } },
      { claudeAiOauth: { accessToken: "header\ninjection" } }, { claudeAiOauth: { accessToken: "x".repeat(70_000) } }]) {
      await writeFile(join(home, ".claude/.credentials.json"), JSON.stringify(value));
      assert.equal(await readNativeCredential("claude", options), undefined);
    }
    await writeFile(join(home, ".claude/.credentials.json"), "not json");
    assert.equal(await readNativeCredential("claude", options), undefined);
    await mkdir(join(home, ".config/cursor"), { recursive: true });
    await writeFile(join(home, ".config/cursor/auth.json"), JSON.stringify({ accessToken: "linux-token" }));
    assert.equal(await readNativeCredential("cursor", options), "linux-token");
    await mkdir(join(home, "AppData/Roaming/Cursor"), { recursive: true });
    await writeFile(join(home, "AppData/Roaming/Cursor/auth.json"), JSON.stringify({ accessToken: "windows-token" }));
    assert.equal(await readNativeCredential("cursor", { ...options, platform: "win32" }), "windows-token");
    await writeFile(join(home, ".claude/settings.json"), "{}");
    await mkdir(join(home, ".cursor"));
    await writeFile(join(home, ".cursor/cli-config.json"), "{}");
    for (const provider of ["claude", "cursor"] as const) {
      const base = { ...options, platform: "darwin" as const };
      assert.equal(await readNativeCredential(provider, base), undefined, "A foreign HOME never reads the OS user's keychain.");
      assert.equal(await readNativeCredential(provider, { ...base, keychain: async () => { throw Error("locked"); } }), undefined);
      assert.equal(await readNativeCredential(provider, { ...base, keychain: async () => undefined }), undefined);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native keychain reads are bounded and do not put credential values on a command line", async () => {
  const calls: any[] = [];
  const success = ((_file: string, args: string[], options: unknown, done: Function) => {
    calls.push([args, options]); done(null, " secret ");
  }) as any;
  assert.equal(await readNativeKeychain("service", "account", success), "secret");
  assert.deepEqual(calls[0][0], ["find-generic-password", "-s", "service", "-a", "account", "-w"]);
  assert.equal(calls[0][1].timeout, 3_000);
  const failed = ((_file: string, _args: string[], _options: unknown, done: Function) => done(Error("locked"), "")) as any;
  assert.equal(await readNativeKeychain("service", undefined, failed), undefined);
  const empty = ((_file: string, _args: string[], _options: unknown, done: Function) => done(null, "")) as any;
  assert.equal(await readNativeKeychain("service", undefined, empty), undefined);
});

test("an expired Claude Code login is told apart from no login", async () => {
  const { claudeCredentialState } = await import("../credentials");
  const home = await mkdtemp(join(tmpdir(), "granttap-claude-state-"));
  const save = async (file: string, data: unknown) => {
    await mkdir(join(home, file, ".."), { recursive: true });
    await writeFile(join(home, file), JSON.stringify(data));
  };
  const options = { home, env: {}, platform: "darwin" as const, keychain: async () => undefined, now: 1_000 };
  try {
    assert.equal(await claudeCredentialState(options), "absent");
    await save(".claude/.credentials.json", { claudeAiOauth: { accessToken: "lapsed", expiresAt: 500 } });
    assert.equal(await claudeCredentialState(options), "expired");
    await save(".claude/.credentials.json", { claudeAiOauth: { accessToken: "current", expiresAt: 5_000 } });
    assert.equal(await claudeCredentialState(options), "valid");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a large settings file and a stale credentials file cannot hide a live Keychain login", async () => {
  const { claudeAccessRenewable, claudeCredentialState } = await import("../credentials");
  const home = await mkdtemp(join(tmpdir(), "granttap-claude-live-"));
  const save = async (file: string, data: string) => {
    await mkdir(join(home, file, ".."), { recursive: true });
    await writeFile(join(home, file), data);
  };
  const live = { claudeAiOauth: { accessToken: "live", refreshToken: "renews", expiresAt: 9_000 } };
  let keychain = JSON.stringify(live);
  const options = { home, env: {}, platform: "darwin" as const, keychain: async () => keychain, now: 1_000 };
  try {
    // Claude Code's settings outgrow 64 KB with saved permissions; it is still installed.
    await save(".claude/settings.json", JSON.stringify({ permissions: { allow: ["x".repeat(100_000)] } }));
    await save(".claude/.credentials.json", JSON.stringify({ claudeAiOauth: { expiresAt: 500 } }));
    assert.equal(await readNativeCredential("claude", options), "live");
    assert.equal(await claudeCredentialState(options), "valid");
    assert.equal(await claudeAccessRenewable(options), false, "a usable access token needs no renewal");
    keychain = JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "renews", expiresAt: 500 } });
    assert.equal(await claudeCredentialState(options), "valid",
      "an expired access token with a refresh token is renewed by Claude Code on its next run");
    assert.equal(await claudeAccessRenewable(options), true, "until then nothing can be read, and the last reading stands");
    keychain = JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: 500 } });
    assert.equal(await claudeCredentialState(options), "expired");
    assert.equal(await claudeAccessRenewable(options), false, "without a refresh token the login has lapsed");
  } finally { await rm(home, { recursive: true, force: true }); }
});
