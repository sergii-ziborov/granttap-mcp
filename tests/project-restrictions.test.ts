import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateEffectiveAction } from "../apps/bridge/src/policy/effective-action";
import {
  checkRepository,
  countLines,
  evaluateContent,
  evaluateWriteRestrictions,
  functionLineCounts,
  rememberRestrictions,
} from "../apps/bridge/src/mesh/restrictions";
import {
  environmentProcessEnv,
  redactEnvironment,
  rememberEnvironment,
} from "../apps/bridge/src/mesh/project-env";

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
