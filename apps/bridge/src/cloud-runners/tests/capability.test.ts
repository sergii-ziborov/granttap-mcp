import assert from "node:assert/strict";
import test from "node:test";
import type { AgentIntegrationStatus } from "../../../../../packages/protocol/schema";
import { claudeSupportsCloud, codexSupportsCloud, createCloudSupportCache } from "../capability";
import { withCloudRunners } from "..";

const claudeHelp = "Options:\n  --cloud [description|session_id|url]  Create a cloud session with the given description";
const codexHelp = "Submit a new Codex Cloud task without launching the TUI\n\nUsage: codex cloud exec [OPTIONS] --env <ENV_ID> [QUERY]";

test("cloud support is read from the installed CLI's own help, never assumed", () => {
  assert.equal(claudeSupportsCloud(claudeHelp), true);
  assert.equal(claudeSupportsCloud("Options:\n  --remote-control [name]"), false);
  assert.equal(claudeSupportsCloud(""), false);
  assert.equal(codexSupportsCloud(codexHelp), true);
  assert.equal(codexSupportsCloud("error: unrecognized subcommand 'cloud'"), false);
});

test("probes run in the background, once per binary, and a changed binary is asked again", async () => {
  let clock = 1_000;
  const asked: string[] = [];
  const cache = createCloudSupportCache(async (binary) => {
    asked.push(binary);
    return binary.includes("claude") ? claudeHelp : binary.includes("new-codex") ? codexHelp : "unknown";
  }, () => clock);
  assert.deepEqual(cache.current({ claude: "/bin/claude", codex: "/bin/codex" }), { claude: false, codex: false },
    "unknown until the CLI answered");
  await cache.settled();
  assert.deepEqual(cache.current({ claude: "/bin/claude", codex: "/bin/codex" }), { claude: true, codex: false });
  assert.equal(asked.length, 2);
  clock += 60_000;
  cache.current({ claude: "/bin/claude", codex: "/bin/codex" });
  await cache.settled();
  assert.equal(asked.length, 2, "cached between catalog cycles");
  cache.current({ claude: "/bin/claude", codex: "/bin/new-codex" });
  await cache.settled();
  assert.deepEqual(cache.current({ claude: "/bin/claude", codex: "/bin/new-codex" }), { claude: true, codex: true });
  assert.equal(asked.length, 3, "only the changed binary is asked");
  clock += 11 * 60_000;
  cache.current({ claude: "/bin/claude", codex: "/bin/new-codex" });
  await cache.settled();
  assert.equal(asked.length, 5, "an updated install is asked again after ten minutes");
});

test("only installed Claude and Codex rows say they can start a cloud run", () => {
  const rows: AgentIntegrationStatus[] = [
    { agent: "codex", installed: true, hookConfigured: true },
    { agent: "claude", installed: false, hookConfigured: false },
    { agent: "cursor", installed: true, hookConfigured: false },
    { agent: "grok", installed: true, hookConfigured: false },
  ];
  assert.deepEqual(withCloudRunners(rows, { claude: true, codex: true }).map(row => row.cloud), [true, undefined, undefined, undefined]);
  assert.deepEqual(withCloudRunners(rows, { claude: false, codex: false }), rows);
});
