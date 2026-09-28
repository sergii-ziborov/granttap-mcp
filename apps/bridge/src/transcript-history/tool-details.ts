import { safeParse } from "../sessions/support/common";
import { redactSecrets } from "../sessions/telemetry/command-preview";

export type ToolCallDetail = { callText: string; resultText?: string; detailTruncated?: boolean };
function display(value: unknown): { text: string; truncated: boolean } {
  const blocks = Array.isArray(value) ? value : (value as { content?: unknown } | null)?.content;
  const raw = typeof value === "string" ? value : Array.isArray(blocks)
    ? blocks.map((block) => typeof block?.text === "string" ? block.text : JSON.stringify(block)).join("\n")
    : JSON.stringify(value ?? "", null, 2);
  const clean = redactSecrets(raw).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  return { text: clean.slice(0, 16_384), truncated: clean.length > 16_384 };
}

/** Expanded calls carry readable newlines; timeline labels remain compact. */
export function recordedToolDetails(lines: readonly string[]): Map<string, ToolCallDetail> {
  const details = new Map<string, ToolCallDetail>();
  for (const line of lines) {
    const row = safeParse(line), p = row?.payload;
    if (row?.type !== "response_item" || !p?.call_id) continue;
    if (["function_call", "custom_tool_call"].includes(p.type)) {
      let input = p.input ?? p.arguments;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* raw source */ } }
      const call = display(input);
      details.set(p.call_id, { callText: call.text, detailTruncated: call.truncated });
    } else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
      const detail = details.get(p.call_id);
      if (!detail) continue;
      const result = display(p.output ?? p.content ?? p.result);
      detail.resultText = result.text;
      detail.detailTruncated = detail.detailTruncated || result.truncated;
    }
  }
  return details;
}
