import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateEffectiveAction } from "../../apps/bridge/src/policy/effective-action";
import {
  checkRepository,
  countLines,
  evaluateContent,
  evaluateWriteRestrictions,
  functionLineCounts,
  loadRestrictions,
  pathMatches,
  rememberRestrictions,
  restrictionSummary,
  runRestrictionsCheck,
  writeCandidate,
} from "../../apps/bridge/src/mesh/restrictions";
import {
  environmentProcessEnv,
  environmentSummary,
  envFileExists,
  loadEnvironment,
  redactEnvironment,
  rememberEnvironment,
  writeRepoEnv,
} from "../../apps/bridge/src/mesh/context/env";

function isolate(): void {
  process.env.GRANTTAP_CONFIG_DIR = mkdtempSync(join(tmpdir(), "granttap-restrict-"));
}

const fileRule = {
  projectId: "proj",
  revision: 1,
  scope: "project" as const,
  source: "phone" as const,
  rules: [{
    ruleId: "max-file-lines",
    kind: "max_file_lines" as const,
    limit: 500,
    effect: "deny" as const,
  }],
};

test("a file over the line limit is a denial; a short file is clean", () => {
  const long = `${"const x = 1;\n".repeat(501)}`;
  assert.equal(countLines(long), 501);
  const hit = evaluateContent(fileRule.rules, "src/big.ts", long);
  assert.equal(hit?.effect, "deny");
  assert.match(hit?.reason ?? "", /501 lines/);
  assert.equal(evaluateContent(fileRule.rules, "src/ok.ts", "const x = 1;\n"), undefined);
});

test("a later DENY takes precedence over an earlier ASK and an Engine ALLOW", async () => {
  isolate();
  const rules = [
    { ruleId: "review", kind: "max_file_lines" as const, limit: 1, effect: "ask" as const },
    { ruleId: "forbid", kind: "max_file_bytes" as const, limit: 1, effect: "deny" as const },
  ];
  assert.equal(evaluateContent(rules, "src/a.ts", "line one\nline two")?.effect, "deny");
  rememberRestrictions("proj", { ...fileRule, rules: [rules[0]!] });
  const decision = await evaluateEffectiveAction({
    provider: "claude", toolName: "Write",
    toolInput: { file_path: "src/a.ts", content: "line one\nline two" },
  }, {
    env: { GRANTTAP_ENGINE_ENABLED: "1", GRANTTAP_PROJECT_POLICY_ENABLED: "1" },
    projectId: "proj",
    client: {
      request: async () => ({ operation: "policy.evaluated", decision: {
        effect: "deny", source: "project", reason: "Engine forbids this write",
      } }),
      close: () => undefined,
    },
  });
  assert.equal(decision.effect, "deny");
  assert.equal(decision.engineEvaluated, true);
});

test("function line counts measure brace-depth bodies", () => {
  const source = [
    "function small() {",
    "  return 1;",
    "}",
    "function big() {",
    ...Array.from({ length: 8 }, () => "  void 0;"),
    "}",
  ].join("\n");
  assert.deepEqual(functionLineCounts(source), [3, 10]);
  const hit = evaluateContent([{
    ruleId: "max-function-lines", kind: "max_function_lines", limit: 5, effect: "deny",
  }], "src/fn.ts", source);
  assert.match(hit?.reason ?? "", /10 lines/);
});

test("remembered restrictions gate Write even when the engine is off", async () => {
  isolate();
  rememberRestrictions("proj", fileRule);
  const denied = evaluateWriteRestrictions({
    projectId: "proj",
    toolName: "Write",
    toolInput: { file_path: "src/a.ts", content: `${"line\n".repeat(501)}` },
  });
  assert.equal(denied?.effect, "deny");
  const decision = await evaluateEffectiveAction({
    provider: "claude",
    toolName: "Write",
    toolInput: { file_path: "src/a.ts", content: `${"line\n".repeat(501)}` },
  }, { env: {}, projectId: "proj" });
  assert.equal(decision.effect, "deny");
  assert.equal(decision.engineEvaluated, false);
  assert.match(decision.reason, /lines/);
});

test("CI check walks the tree and skips node_modules", () => {
  isolate();
  const root = mkdtempSync(join(tmpdir(), "granttap-restrict-repo-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "ok.ts"), "export const ok = 1;\n");
  writeFileSync(join(root, "src", "big.ts"), `${"export const x = 1;\n".repeat(501)}`);
  writeFileSync(join(root, "node_modules", "pkg", "huge.ts"), `${"x\n".repeat(800)}`);
  const hits = checkRepository(root, fileRule);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.path, "src/big.ts");
});

test("secret env values stay off the snapshot and still inject into a process", () => {
  isolate();
  const stored = rememberEnvironment("proj", {
    projectId: "proj",
    revision: 2,
    shareNonSecretsWithRepo: false,
    variables: [
      { key: "PUBLIC_URL", value: "https://example.test", secret: false },
      { key: "API_TOKEN", value: "secret-token", secret: true },
    ],
  });
  const redacted = redactEnvironment(stored);
  assert.equal(redacted?.variables.find((item) => item.key === "API_TOKEN")?.value, undefined);
  assert.equal(redacted?.variables.find((item) => item.key === "PUBLIC_URL")?.value, "https://example.test");
  assert.deepEqual(environmentProcessEnv(stored), {
    PUBLIC_URL: "https://example.test",
    API_TOKEN: "secret-token",
  });
});

test("a later env set without a secret value keeps the value already held", () => {
  isolate();
  rememberEnvironment("proj", {
    projectId: "proj",
    revision: 1,
    shareNonSecretsWithRepo: false,
    variables: [{ key: "API_TOKEN", value: "kept", secret: true }],
  });
  const next = rememberEnvironment("proj", {
    projectId: "proj",
    revision: 2,
    shareNonSecretsWithRepo: false,
    variables: [{ key: "API_TOKEN", secret: true }],
  });
  assert.equal(next?.variables[0]?.value, "kept");
});

test("redacted secret cannot be declassified by changing only its flag", () => {
  isolate();
  rememberEnvironment("proj", {
    projectId: "proj", revision: 1, shareNonSecretsWithRepo: false,
    variables: [{ key: "API_TOKEN", value: "held", secret: true }],
  });
  const next = rememberEnvironment("proj", {
    projectId: "proj", revision: 2, shareNonSecretsWithRepo: false,
    variables: [{ key: "API_TOKEN", secret: false }],
  });
  assert.equal(next?.variables[0]?.secret, true);
  assert.equal(redactEnvironment(next)?.variables[0]?.value, undefined);
});

test("Project environment cannot override host runtime and provider routing", () => {
  isolate();
  for (const key of ["HOME", "PATH", "NODE_OPTIONS", "GRANTTAP_ENGINE_SOCKET", "OPENAI_API_KEY"]) {
    assert.throws(() => rememberEnvironment("proj", {
      projectId: "proj", revision: 1, shareNonSecretsWithRepo: false,
      variables: [{ key, value: "override", secret: false }],
    }), /protected runtime key/);
  }
  assert.equal(loadEnvironment("proj"), undefined);
  assert.deepEqual(environmentProcessEnv({
    projectId: "legacy", revision: 1, shareNonSecretsWithRepo: false,
    variables: [{ key: "PATH", value: "legacy", secret: false }],
  }), {});
});

test("path globs, byte limits, and summaries cover the rest of the gate", () => {
  isolate();
  assert.equal(pathMatches("src/a.ts", "src/*.ts"), true);
  assert.equal(pathMatches("src/nested/a.ts", "src/*.ts"), false);
  assert.equal(pathMatches("src/a.ts", "**"), true);
  const bytes = evaluateContent([{
    ruleId: "max-bytes", kind: "max_file_bytes", limit: 8, effect: "ask",
  }], "src/a.ts", "0123456789");
  assert.equal(bytes?.effect, "ask");
  assert.match(bytes?.reason ?? "", /bytes/);
  const skipped = evaluateContent([{
    ruleId: "only-swift", kind: "max_file_lines", limit: 1, effect: "deny",
    paths: ["**/*.swift"],
  }], "src/a.ts", "one\ntwo\n");
  assert.equal(skipped, undefined);
  assert.equal(restrictionSummary(undefined), "No restrictions");
  assert.equal(restrictionSummary(fileRule), "1 rule · this Project");
  assert.equal(restrictionSummary({
    ...fileRule, scope: "project_and_repo", rules: fileRule.rules.concat(fileRule.rules),
  }), "2 rules · Project and repository");
  assert.equal(restrictionSummary({
    ...fileRule, scope: "sync_from_repo",
  }), "1 rule · from the repository");
});

test("write candidates reconstruct Edit and MultiEdit from disk", () => {
  isolate();
  const root = mkdtempSync(join(tmpdir(), "granttap-restrict-edit-"));
  writeFileSync(join(root, "a.ts"), "alpha\nbeta\n");
  const edited = writeCandidate("Edit", {
    file_path: "a.ts", old_string: "beta", new_string: "gamma",
  }, root);
  assert.equal(edited?.content, "alpha\ngamma\n");
  const multi = writeCandidate("MultiEdit", {
    path: join(root, "a.ts"),
    edits: [
      { old_string: "alpha", new_string: "one" },
      { old_string: "beta", new_string: "two" },
    ],
  });
  assert.equal(multi?.content, "one\ntwo\n");
  assert.equal(writeCandidate("Read", { file_path: "a.ts" }, root), undefined);
  assert.equal(evaluateWriteRestrictions({ projectId: "proj", toolName: "Write" }), undefined);
});

test("project_and_repo writes the repo file; sync_from_repo reads it back", () => {
  isolate();
  const root = mkdtempSync(join(tmpdir(), "granttap-restrict-scope-"));
  const shared = rememberRestrictions("proj", {
    ...fileRule, scope: "project_and_repo",
  }, root);
  assert.equal(shared?.scope, "project_and_repo");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "ok.ts"), "export const ok = 1;\n");
  const clean = runRestrictionsCheck(root);
  assert.equal(clean.exitCode, 0);
  assert.match(clean.stdout, /1 rule/);
  writeFileSync(join(root, "src", "big.ts"), `${"export const x = 1;\n".repeat(501)}`);
  const denied = runRestrictionsCheck(root);
  assert.equal(denied.exitCode, 1);
  assert.match(denied.stderr, /DENY/);
  rememberRestrictions("proj", undefined);
  assert.equal(loadRestrictions("proj"), undefined);
  const synced = rememberRestrictions("proj", {
    ...fileRule, scope: "sync_from_repo", source: "phone",
  }, root);
  assert.equal(synced?.source, "repo");
  assert.equal(runRestrictionsCheck(root).exitCode, 1);
});

test("CI check reports none when no rules are configured", () => {
  isolate();
  const root = mkdtempSync(join(tmpdir(), "granttap-restrict-empty-"));
  writeFileSync(join(root, "ok.ts"), "export const ok = 1;\n");
  const none = runRestrictionsCheck(root);
  assert.equal(none.exitCode, 0);
  assert.match(none.stdout, /none configured/);
});

test("non-secret env can be shared with the repository and summarized", () => {
  isolate();
  const root = mkdtempSync(join(tmpdir(), "granttap-env-repo-"));
  const stored = rememberEnvironment("proj", {
    projectId: "proj",
    revision: 1,
    shareNonSecretsWithRepo: true,
    variables: [
      { key: "PUBLIC_URL", value: "https://example.test", secret: false },
      { key: "API_TOKEN", value: "secret-token", secret: true },
      { key: "QUOTED", value: "has space", secret: false },
    ],
  }, root);
  assert.equal(envFileExists(root), true);
  writeRepoEnv(root, stored?.variables ?? []);
  assert.equal(loadEnvironment("proj")?.variables.length, 3);
  assert.match(environmentSummary(stored), /3 variables/);
  assert.match(environmentSummary(stored), /secret/);
  assert.match(environmentSummary(stored), /shared with the repository/);
  assert.equal(environmentSummary(undefined), "No variables");
  rememberEnvironment("proj", undefined);
  assert.equal(loadEnvironment("proj"), undefined);
});
