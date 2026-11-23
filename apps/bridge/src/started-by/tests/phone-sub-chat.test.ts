import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UserMessage } from "../../../../../packages/protocol/schema";
import { linkStartedFromPhone } from "../../monitor/handlers/user-message";
import { attachStartedBy } from "../attach";
import { startedByLink } from "../links";

test("a chat the phone starts for another one is linked beneath it, and drawn there", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "granttap-sub-chat-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = folder;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(folder, { recursive: true, force: true });
  });
  const parent = { agent: "claude" as const, sessionId: "parent-chat-0001" };
  const message = UserMessage.parse({ type: "user.message", text: "Draw the hero image", agent: "codex",
    cwd: "/repo", startedBy: parent, createdAt: 1 });
  assert.deepEqual(message.startedBy, parent);
  assert.throws(() => UserMessage.parse({ type: "user.message", text: "x", createdAt: 1,
    startedBy: { agent: "someone", sessionId: "x" } }), "a parent of an unknown agent is refused");

  linkStartedFromPhone("codex", "child-chat-0001", message.startedBy);
  assert.deepEqual(startedByLink({ agent: "codex", sessionId: "child-chat-0001" })?.parent, parent);
  linkStartedFromPhone("claude", "parent-chat-0001", parent);
  assert.equal(startedByLink(parent), undefined, "a chat is never its own parent");
  linkStartedFromPhone("codex", "plain-chat-0001", undefined);
  assert.equal(startedByLink({ agent: "codex", sessionId: "plain-chat-0001" }), undefined);

  const [row] = attachStartedBy([{ sessionId: "child-chat-0001", agent: "codex", state: "working", startedAt: 1,
    lastActivityAt: 2, tokensSession: 0, tokensLastTurn: 0 }], []);
  assert.deepEqual(row!.startedBy, parent, "the catalog names the chat it was started for");
});
