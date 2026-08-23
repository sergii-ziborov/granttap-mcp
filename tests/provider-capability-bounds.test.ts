import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cursorCapabilityUsage, scanCursor } from "../apps/bridge/src/sessions/cursor";
import { scanCapabilityUsage } from "../apps/bridge/src/sessions";
import { MAX_CAPABILITY_USAGE_EVENTS, MAX_CAPABILITY_USAGE_PAYLOAD_BYTES } from "../apps/bridge/src/sessions/telemetry";

function setEnv(t: test.TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  });
}

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test("Cursor cache enforces observation count and wire payload bounds", async (t) => {
  const cursorRoot = await mkdtemp(join(tmpdir(), "granttap-cursor-usage-bound-"));
  const cursorSessionId = "cursor-usage-bound";
  const cursorSessionDir = join(cursorRoot, "workspace", "agent-transcripts", cursorSessionId);
  await mkdir(cursorSessionDir, { recursive: true });
  const now = Date.now();
  await writeFile(join(cursorSessionDir, `${cursorSessionId}.jsonl`), jsonl([
    { timestamp: now, role: "user", message: { content: "Bound Cursor telemetry" } },
    {
      timestamp: now + 100,
      role: "assistant",
      message: {
        content: Array.from({ length: 260 }, (_, index) => ({
          type: "tool_use",
          id: `cursor-bound-${index}`,
          name: "Shell",
          input: { command: `echo cursor-${index}` },
        })),
      },
    },
  ]));
  setEnv(t, "GRANTTAP_CURSOR_TRANSCRIPTS_DIR", cursorRoot);
  setEnv(t, "GRANTTAP_CURSOR_STATE_DB", join(cursorRoot, "missing-state.vscdb"));
  const cursorScan = scanCursor();
  assert.equal(cursorCapabilityUsage(cursorScan.sessions[0]!).length, MAX_CAPABILITY_USAGE_EVENTS);

  const status = scanCapabilityUsage([cursorScan.sessions[0]!]);
  assert.ok(status.events.length <= MAX_CAPABILITY_USAGE_EVENTS);
  assert.ok(Buffer.byteLength(JSON.stringify(status), "utf8") <= MAX_CAPABILITY_USAGE_PAYLOAD_BYTES);
});
