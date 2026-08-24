/**
 * Trusted attribution for GrantTap MCP calls.
 *
 * The MCP server sees a tool call but not which agent session made it, so a
 * model that learns another execution's session id could otherwise publish
 * events in its name. Provider hooks do know the session: they run inside it
 * and receive the exact arguments. Each hook records a single-use, short-lived
 * attribution keyed by those arguments, and the MCP server consumes it instead
 * of trusting anything the model claimed.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "../config";

const CALL_TTL_MS = 120_000;
const MAX_RECORDS = 32;

const AttributedCall = z.object({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  provider: z.enum(["claude", "codex", "cursor", "grok"]),
  sessionId: z.string().trim().min(1).max(256),
  expiresAt: z.number().positive(),
}).strict();
export type AttributedCall = z.infer<typeof AttributedCall>;

const CallFile = z.object({
  version: z.literal(1),
  calls: z.array(AttributedCall).max(MAX_RECORDS),
}).strict();

/** Normalize exactly like the wire schemas so hook and server agree byte for byte. */
function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined && item !== null) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

/** The GrantTap tool name as each provider spells it, reduced to one token. */
export function grantTapToolName(rawToolName: unknown): string | undefined {
  const raw = String(rawToolName ?? "").trim();
  const tool = raw.includes("__") ? raw.split("__").at(-1)! : raw;
  return ["notify", "connect", "ask", "ask_yes_no"].includes(tool) ? tool : undefined;
}

export function meshCallKey(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ tool, args: canonical(args) }))
    .digest("hex");
}

function callFilePath(): string {
  return join(configDir(), "mesh-tool-calls.json");
}

function readCalls(now: number): AttributedCall[] {
  try {
    const parsed = CallFile.safeParse(JSON.parse(readFileSync(callFilePath(), "utf8")));
    if (!parsed.success) return [];
    return parsed.data.calls.filter((call) => call.expiresAt > now);
  } catch {
    return [];
  }
}

function writeCalls(calls: AttributedCall[]): void {
  const path = callFilePath();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(CallFile.parse({ version: 1, calls: calls.slice(-MAX_RECORDS) }), null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

/**
 * Record that this provider session is about to make one GrantTap tool call.
 * Hooks call this before returning their decision; it never blocks the hook.
 */
export function recordAttributedCall(input: {
  provider: AttributedCall["provider"];
  sessionId: unknown;
  toolName: unknown;
  args: unknown;
  now?: number;
}): void {
  const tool = grantTapToolName(input.toolName);
  const sessionId = String(input.sessionId ?? "").trim();
  if (tool !== "notify" || !sessionId || sessionId.length > 256) return;
  const now = input.now ?? Date.now();
  try {
    const call = AttributedCall.parse({
      key: meshCallKey(tool, input.args),
      provider: input.provider,
      sessionId,
      expiresAt: now + CALL_TTL_MS,
    });
    const kept = readCalls(now).filter((item) =>
      item.key !== call.key || item.sessionId !== call.sessionId);
    writeCalls([...kept, call]);
  } catch {
    // Attribution is best effort inside the hook; the MCP server fails closed.
  }
}

/**
 * Resolve the session that actually made this call, then retire the record.
 * Two live sessions claiming the same arguments are ambiguous and rejected.
 */
export function consumeAttributedCall(
  tool: string,
  args: unknown,
  now = Date.now(),
): AttributedCall | undefined {
  const key = meshCallKey(tool, args);
  const live = readCalls(now);
  const matches = live.filter((call) => call.key === key);
  const sessions = new Set(matches.map((call) => call.sessionId));
  if (matches.length === 0 || sessions.size !== 1) {
    if (matches.length > 0) writeCalls(live.filter((call) => call.key !== key));
    return undefined;
  }
  writeCalls(live.filter((call) => call.key !== key));
  return matches[0];
}
