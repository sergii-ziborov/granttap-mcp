import assert from "node:assert/strict";
import test from "node:test";
import { claudeCapabilityUsage, slashCommandSkill } from "../apps/bridge/src/sessions/claude";
import type { SessionInfo } from "../packages/protocol/schema";

const at = 1_800_000_000_000;
const session = {
  sessionId: "chat", agent: "claude", cwd: "/repo", state: "idle", startedAt: at, lastActivityAt: at + 9_000,
  tokensSession: 0, tokensLastTurn: 0,
} as unknown as SessionInfo;

function userTurn(text: string, uuid: string, offset: number): string {
  return JSON.stringify({
    type: "user", uuid, timestamp: new Date(at + offset).toISOString(),
    message: { role: "user", content: text },
  });
}

test("a skill invoked as a slash command is a skill used, a housekeeping command is not", () => {
  assert.equal(slashCommandSkill({ type: "user", message: { role: "user", content: "<command-name>/commit</command-name>\n<command-message>commit</command-message>" } }), "commit");
  assert.equal(slashCommandSkill({ type: "user", message: { role: "user", content: [{ type: "text", text: "<command-name>skill-doctor</command-name>" }] } }), "skill-doctor");
  assert.equal(slashCommandSkill({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }), undefined, "the terminal's own command");
  assert.equal(slashCommandSkill({ type: "user", message: { role: "user", content: "just words" } }), undefined);
  assert.equal(slashCommandSkill({ type: "assistant", message: { role: "assistant", content: "<command-name>/commit</command-name>" } }), undefined);
  assert.equal(slashCommandSkill({ type: "user", message: { role: "user", content: "<command-name>/bad name!</command-name>" } }), undefined);

  const lines = [
    userTurn("<command-name>/commit</command-name>\n<command-args>-m x</command-args>", "u1", 1_000),
    userTurn("<command-name>/clear</command-name>", "u2", 2_000),
    JSON.stringify({
      type: "assistant", uuid: "a1", timestamp: new Date(at + 3_000).toISOString(),
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "artifact-design" } }] },
    }),
    JSON.stringify({
      type: "user", uuid: "u3", timestamp: new Date(at + 4_000).toISOString(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    }),
    userTurn("<command-name>/commit</command-name>", "u1", 1_000),
  ];
  const observed = claudeCapabilityUsage(session, lines);
  const skills = observed.filter((item) => item.skill)
    .map((item) => [item.toolName, item.skill, item.outcome])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(skills, [
    ["/commit", "commit", "success"],
    ["Skill", "artifact-design", "success"],
  ], "the slash command and the model's own Skill call both count, once each; /clear does not");
  assert.equal(observed.find((item) => item.skill === "commit")?.createdAt, at + 1_000);
});
