import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordedToolDetails } from "../tool-details";
import { previousNativeLines } from "../native-lines";
import { codexLogPathBySession } from "../../sessions/scan/codex/shared";
import { nativeImageLines } from "../images";
import { codexImageChunk } from "../../sessions/scan/codex/image";

const row = (payload: unknown) => JSON.stringify({ type: "response_item", payload });

test("expanded tool details preserve readable structured output, redaction and bounds", () => {
  const rows = [row({ type: "custom_tool_call", call_id: "a", input: "first\nlast" }),
    row({ type: "custom_tool_call_output", call_id: "a", output: { content: [{ type: "text", text: "one" }, { text: "two" }] } }),
    row({ type: "function_call", call_id: "b", arguments: JSON.stringify({ cmd: "line\nnext", token: "sk-" + "a".repeat(40) }) }),
    row({ type: "function_call_output", call_id: "b", output: "x".repeat(20_000) }),
    row({ type: "function_call_output", call_id: "missing", output: "ignored" }),
    "invalid json"];
  const details = recordedToolDetails(rows);
  assert.equal(details.get("a")?.callText, "first\nlast");
  assert.equal(details.get("a")?.resultText, "one\ntwo");
  assert.ok(!details.get("b")?.callText.includes("sk-"));
  assert.equal(details.get("b")?.resultText?.length, 16_384);
  assert.equal(details.get("b")?.detailTruncated, true);
  assert.equal(details.has("missing"), false);
});

test("native cursors stay stable as the log grows and reject another log", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-native-page-"));
  t.after(() => rmSync(root, { recursive: true }));
  const path = join(root, "log.jsonl"), other = join(root, "other.jsonl");
  writeFileSync(path, "first\nsecond\npartial");
  writeFileSync(other, "first\nsecond\n");
  const window = previousNativeLines(path, "s")!;
  const cursor = window.cursorAt(6);
  assert.deepEqual(window.lines.map((line) => [line.text, line.offset]), [["first", 0], ["second", 6]]);
  appendFileSync(path, " end\nnewest\n");
  assert.deepEqual(previousNativeLines(path, "s", cursor)?.lines.map((line) => line.text), ["first"]);
  assert.equal(previousNativeLines(other, "s", cursor), undefined);
  assert.equal(previousNativeLines(path, "other", cursor), undefined);
  assert.equal(previousNativeLines(path, "s", Buffer.from(JSON.stringify({ identity: "wrong", offset: -1 })).toString("base64url")), undefined);
});

test("older native images remain reachable beyond the latest transcript window", (t) => {
  const root = mkdtempSync(join(tmpdir(), "granttap-history-image-"));
  const sessionId = "image-history-test", path = join(root, "log.jsonl");
  t.after(() => { codexLogPathBySession.delete(sessionId); rmSync(root, { recursive: true }); });
  const imageRow = JSON.stringify({ timestamp: new Date(1000).toISOString(), type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] } });
  writeFileSync(path, imageRow + "\n" + JSON.stringify({ timestamp: new Date(2000).toISOString(),
    type: "ignored", payload: { data: "x".repeat(17 * 1024 * 1024) } }) + "\n");
  codexLogPathBySession.set(sessionId, path);
  assert.deepEqual(nativeImageLines(sessionId, `${sessionId}:1000:0`), [imageRow]);
  assert.equal(nativeImageLines(sessionId, "other:1000:0"), undefined);
  assert.equal(nativeImageLines(sessionId, `${sessionId}:500:0`), undefined);
  const chunk = codexImageChunk(sessionId, `${sessionId}:1000:0`, 0);
  assert.equal(Buffer.from(chunk?.data_base64 ?? "", "base64").toString(), "hello");
});
