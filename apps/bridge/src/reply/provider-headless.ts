import { randomUUID } from "node:crypto";
import type { SessionInfo } from "../../../../packages/protocol/schema";
import { runProcess } from "./process";
import type { ReplyResult } from "./types";

function cursorBin(): string {
  return process.env.GRANTTAP_CURSOR_AGENT_BIN ?? "cursor-agent";
}

function grokBin(): string {
  return process.env.GRANTTAP_GROK_BIN ?? "grok";
}

function parseCursor(stdout: string, fallback?: string): ReplyResult {
  try {
    const value = JSON.parse(stdout) as {
      is_error?: boolean; result?: unknown; session_id?: unknown;
    };
    const text = typeof value.result === "string" ? value.result.trim() : "";
    if (value.is_error) return { ok: false, error: text || "Cursor returned an error." };
    if (text) return {
      ok: true, text: text.slice(0, 4_000),
      sessionId: typeof value.session_id === "string" ? value.session_id : fallback,
    };
  } catch {
    // Retain a bounded plain-text fallback for older Cursor CLI builds.
  }
  const text = stdout.trim();
  return text
    ? { ok: true, text: text.slice(0, 4_000), sessionId: fallback }
    : { ok: false, error: "Cursor returned an empty response." };
}

function parseGrok(stdout: string, fallback: string): ReplyResult {
  let text = "";
  let sessionId = fallback;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as {
        type?: string; data?: unknown; sessionId?: unknown; session_id?: unknown;
        result?: unknown; error?: unknown;
      };
      if (value.type === "text" && typeof value.data === "string") text += value.data;
      if (value.type === "result" && typeof value.result === "string") text = value.result;
      if (typeof value.sessionId === "string") sessionId = value.sessionId;
      if (typeof value.session_id === "string") sessionId = value.session_id;
      if (value.type === "error" && typeof value.error === "string") {
        return { ok: false, error: value.error.slice(0, 500) };
      }
    } catch {
      // Ignore diagnostic lines outside Grok's streaming JSON contract.
    }
  }
  const visible = text.trim() || stdout.trim();
  return visible
    ? { ok: true, text: visible.slice(0, 4_000), sessionId }
    : { ok: false, error: "Grok Build returned an empty response." };
}

export function runCursorNew(text: string, cwd: string, timeoutMs: number): Promise<ReplyResult> {
  return runProcess(
    cursorBin(), ["-p", "--output-format", "json", text], cwd, timeoutMs, parseCursor,
  );
}

export function runCursorResume(
  session: SessionInfo, text: string, timeoutMs: number,
): Promise<ReplyResult> {
  return runProcess(
    cursorBin(), ["-p", "--resume", session.sessionId, "--output-format", "json", text],
    session.cwd, timeoutMs, (stdout) => parseCursor(stdout, session.sessionId),
  );
}

export function runGrokNew(text: string, cwd: string, timeoutMs: number): Promise<ReplyResult> {
  const sessionId = randomUUID();
  const args = [
    "--no-auto-update", "--cwd", cwd, "--session-id", sessionId,
    "-p", text, "--output-format", "streaming-json",
  ];
  return runProcess(grokBin(), args, cwd, timeoutMs, (stdout) => parseGrok(stdout, sessionId));
}

export function runGrokResume(
  session: SessionInfo, text: string, timeoutMs: number,
): Promise<ReplyResult> {
  const args = [
    "--no-auto-update", ...(session.cwd ? ["--cwd", session.cwd] : []),
    "--resume", session.sessionId, "-p", text, "--output-format", "streaming-json",
  ];
  return runProcess(
    grokBin(), args, session.cwd, timeoutMs,
    (stdout) => parseGrok(stdout, session.sessionId),
  );
}
