/** Deliver phone messages into existing sessions or start a new Codex task. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SessionInfo, UserAttachment } from "../../../packages/protocol/schema";
import { loadRuntimeConfig } from "./config";

const CLAUDE_BIN = process.env.GRANTTAP_CLAUDE_BIN ?? process.env.NODVOX_CLAUDE_BIN ?? "claude";
const CODEX_BIN = process.env.GRANTTAP_CODEX_BIN ?? process.env.NODVOX_CODEX_BIN ?? "codex";

export type ReplyResult =
  | { ok: true; text: string; sessionId?: string }
  | { ok: false; error: string };

const inFlight = new Map<string, Promise<ReplyResult>>();

export type DeliveryOptions = {
  preferredMcp?: string;
  skill?: string;
};

export function deliverToSession(
  session: SessionInfo,
  text: string,
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
  options: DeliveryOptions = {},
): Promise<ReplyResult> {
  return queued(session.sessionId, () => withAttachments(attachments, text, (prepared) =>
    runDelivery(
      session,
      session.agent === "claude" ? prepared.claudePrompt : prepared.prompt,
      timeoutMs,
      prepared.images,
      options,
    ),
  ));
}

/** A message from the phone home screen intentionally creates a new task. */
export function createCodexSession(
  text: string,
  cwd = process.cwd(),
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
): Promise<ReplyResult> {
  return queued("__new_codex_task__", () => withAttachments(attachments, text, (prepared) =>
    runCodexNew(prepared.prompt, cwd, timeoutMs, prepared.images),
  ));
}

/** Start a persisted non-interactive Claude Code task for local scheduling. */
export function createClaudeSession(
  text: string,
  cwd = process.cwd(),
  timeoutMs = 240_000,
  attachments: UserAttachment[] = [],
): Promise<ReplyResult> {
  return queued("__new_claude_task__", () => withAttachments(attachments, text, (prepared) =>
    runClaudeNew(prepared.claudePrompt, cwd, timeoutMs),
  ));
}

const SCHEDULE_PLAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    title: { type: "string" },
    prompt: { type: "string" },
    cron: { type: "string" },
  },
  required: ["reply", "title", "prompt", "cron"],
} as const;

/**
 * Ask the selected local agent to create/refine a scheduler draft without
 * creating a persisted Codex task or Claude conversation. The caller still
 * validates the structured response and cron before returning it to iPhone.
 */
export async function createSchedulePlan(
  agent: "codex" | "claude",
  text: string,
  cwd = process.cwd(),
  timeoutMs = 240_000,
): Promise<ReplyResult> {
  return queued(`__schedule_planner_${agent}__`, async () => {
    if (agent === "claude") {
      const args = [
        "-p",
        "--no-session-persistence",
        "--permission-mode",
        "plan",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(SCHEDULE_PLAN_OUTPUT_SCHEMA),
        text,
      ];
      return runProcess(CLAUDE_BIN, args, cwd, timeoutMs, parseClaudeSchedulePlan);
    }

    const dir = await mkdtemp(join(tmpdir(), "granttap-schedule-plan-"));
    try {
      const schemaPath = join(dir, "output-schema.json");
      await writeFile(schemaPath, `${JSON.stringify(SCHEDULE_PLAN_OUTPUT_SCHEMA)}\n`, { mode: 0o600 });
      const args = [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        "--json",
        "-",
      ];
      return await runProcess(CODEX_BIN, args, cwd, timeoutMs, parseCodexSchedulePlan, text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

function parseCodexSchedulePlan(stdout: string): ReplyResult {
  let lastMessage = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { item?: { type?: string; text?: string } };
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        lastMessage = event.item.text;
      }
    } catch {
      // Codex may emit diagnostics around the JSONL events.
    }
  }
  return lastMessage
    ? { ok: true, text: lastMessage }
    : { ok: false, error: "Codex returned no scheduler draft." };
}

function parseClaudeSchedulePlan(stdout: string): ReplyResult {
  try {
    const parsed = JSON.parse(stdout) as {
      is_error?: boolean;
      result?: string;
      structured_output?: unknown;
    };
    if (parsed.is_error) return { ok: false, error: parsed.result ?? "Claude planner error" };
    if (parsed.structured_output && typeof parsed.structured_output === "object") {
      return { ok: true, text: JSON.stringify(parsed.structured_output) };
    }
    if (typeof parsed.result === "string" && parsed.result.trim()) {
      return { ok: true, text: parsed.result };
    }
  } catch {
    // Fall through to an actionable error; planner output must be structured.
  }
  return { ok: false, error: "Claude returned no structured scheduler draft." };
}

function queued(key: string, run: () => Promise<ReplyResult>): Promise<ReplyResult> {
  const previous = inFlight.get(key) ?? Promise.resolve(null);
  const next = previous.then(run);
  inFlight.set(
    key,
    next.catch(() => null as never),
  );
  return next;
}

function runDelivery(
  session: SessionInfo,
  text: string,
  timeoutMs: number,
  images: string[],
  options: DeliveryOptions,
): Promise<ReplyResult> {
  const routed = routingPrompt(session, text, options);
  if (session.agent === "claude") return runClaude(session, routed, timeoutMs);
  if (session.agent === "codex") return runCodex(session, routed, timeoutMs, images);
  return Promise.resolve({ ok: false, error: `unknown agent: ${session.agent}` });
}

function routingPrompt(session: SessionInfo, text: string, options: DeliveryOptions): string {
  const instructions: string[] = [];
  if (options.preferredMcp) {
    instructions.push(`Use the MCP server "${options.preferredMcp}" for this request when relevant.`);
  }
  if (options.skill) {
    const invocation = session.agent === "claude" ? `/${options.skill}` : `$${options.skill}`;
    instructions.push(`Use the project skill ${invocation} for this request.`);
  }
  return instructions.length === 0 ? text : `${instructions.join("\n")}\n\n${text}`;
}

function runClaude(session: SessionInfo, text: string, timeoutMs: number): Promise<ReplyResult> {
  const disabled = loadRuntimeConfig().sessionMcpDisabled[session.sessionId] ?? [];
  const mcpArgs = disabled.length === 0
    ? []
    : ["--disallowedTools", disabled.map((name) => `mcp__${name}`).join(",")];
  const args = ["-p", "--resume", session.sessionId, ...mcpArgs, "--output-format", "json", text];
  return runProcess(CLAUDE_BIN, args, session.cwd, timeoutMs, (stdout) => {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      if (parsed.is_error) return { ok: false, error: parsed.result ?? "agent error" };
      if (typeof parsed.result === "string") return { ok: true, text: parsed.result };
    } catch {
      // Fall through to the plain output fallback.
    }
    const trimmed = stdout.trim();
    return trimmed
      ? { ok: true, text: trimmed.slice(0, 4000) }
      : { ok: false, error: "Claude returned an empty response." };
  });
}

function runClaudeNew(text: string, cwd: string, timeoutMs: number): Promise<ReplyResult> {
  const args = ["-p", "--output-format", "json", text];
  return runProcess(CLAUDE_BIN, args, cwd, timeoutMs, (stdout) => {
    try {
      const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean; session_id?: string };
      if (parsed.is_error) return { ok: false, error: parsed.result ?? "agent error" };
      if (typeof parsed.result === "string") {
        return { ok: true, text: parsed.result.slice(0, 4000), sessionId: parsed.session_id };
      }
    } catch {
      // Fall through to plain output.
    }
    const trimmed = stdout.trim();
    return trimmed
      ? { ok: true, text: trimmed.slice(0, 4000) }
      : { ok: false, error: "Claude returned an empty response." };
  });
}

function parseCodexJsonl(stdout: string, fallbackSessionId?: string): ReplyResult {
  let lastMessage = "";
  let sessionId = fallbackSessionId;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        thread_id?: string;
        session_id?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === "thread.started") {
        sessionId = event.thread_id ?? event.session_id ?? sessionId;
      }
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        lastMessage = event.item.text;
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  if (lastMessage) return { ok: true, text: lastMessage.slice(0, 4000), sessionId };
  const trimmed = stdout.trim();
  return trimmed
    ? { ok: true, text: trimmed.slice(0, 4000), sessionId }
    : { ok: false, error: "Codex returned an empty response." };
}

function runCodex(
  session: SessionInfo,
  text: string,
  timeoutMs: number,
  images: string[] = [],
): Promise<ReplyResult> {
  const configured = loadRuntimeConfig().sessionAccess[session.sessionId];
  const disabledMcp = loadRuntimeConfig().sessionMcpDisabled[session.sessionId] ?? [];
  const sandbox = configured === "read-only"
    ? "read-only"
    : configured === "workspace"
      ? "workspace-write"
      : configured === "full"
        ? "danger-full-access"
        : null;
  const accessArgs = sandbox ? ["-c", `sandbox_mode="${sandbox}"`] : [];
  const mcpArgs = disabledMcp.flatMap((name) => [
    "-c",
    `mcp_servers.${tomlKey(name)}.enabled=false`,
  ]);
  const imageArgs = images.flatMap((path) => ["-i", path]);
  const args = ["exec", "resume", ...accessArgs, ...mcpArgs, ...imageArgs, session.sessionId, "--json", "-"];
  return runProcess(
    CODEX_BIN,
    args,
    session.cwd,
    timeoutMs,
    (stdout) => parseCodexJsonl(stdout, session.sessionId),
    text,
  );
}

function tomlKey(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function runCodexNew(
  text: string,
  cwd: string,
  timeoutMs: number,
  images: string[] = [],
): Promise<ReplyResult> {
  // This is the supported non-interactive Codex path. It preserves the user's
  // normal sandbox, approval, hooks, model, and auth configuration.
  const imageArgs = images.flatMap((path) => ["-i", path]);
  const args = ["exec", ...imageArgs, "--json", "--skip-git-repo-check", "-"];
  return runProcess(CODEX_BIN, args, cwd, timeoutMs, parseCodexJsonl, text);
}

type PreparedAttachments = { prompt: string; claudePrompt: string; images: string[] };

async function withAttachments(
  attachments: UserAttachment[],
  text: string,
  run: (prepared: PreparedAttachments) => Promise<ReplyResult>,
): Promise<ReplyResult> {
  if (attachments.length === 0) return run({ prompt: text, claudePrompt: text, images: [] });
  const dir = await mkdtemp(join(tmpdir(), "granttap-attachments-"));
  try {
    const files: { path: string; image: boolean; name: string }[] = [];
    for (const [index, attachment] of attachments.slice(0, 5).entries()) {
      const safeName = basename(attachment.name).replace(/[^\p{L}\p{N}._ -]/gu, "_") || `attachment-${index + 1}`;
      const bytes = Buffer.from(attachment.data, "base64");
      if (bytes.length > 6_000_000) throw new Error(`${safeName} is larger than 6 MB.`);
      const path = join(dir, `${index + 1}-${safeName}`);
      await writeFile(path, bytes, { mode: 0o600 });
      files.push({ path, image: attachment.mimeType.startsWith("image/"), name: safeName });
    }
    const documents = files.filter((file) => !file.image);
    const documentNote = documents.length === 0
      ? ""
      : `\n\nAttached files available locally:\n${documents.map((file) => `- ${file.name}: ${file.path}`).join("\n")}`;
    // Claude Code accepts local file/image paths as prompt context. Codex gets
    // images through its supported `-i` flag and only document paths in text.
    const claudeNote = `\n\nAttached files available locally (inspect them as part of this request):\n${files.map((file) => `- ${file.name}: ${file.path}`).join("\n")}`;
    return await run({
      prompt: `${text || "Please inspect the attached content."}${documentNote}`,
      claudePrompt: `${text || "Please inspect the attached content."}${claudeNote}`,
      images: files.filter((file) => file.image).map((file) => file.path),
    });
  } catch (error) {
    return { ok: false, error: `Could not prepare attachment: ${(error as Error).message}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runProcess(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  parse: (stdout: string) => ReplyResult,
  stdin?: string,
): Promise<ReplyResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: `${command} did not start: ${(error as Error).message}` });
      return;
    }

    if (stdin != null) child.stdin?.end(stdin);
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: `${command} did not respond within ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `${command}: ${error.message}` });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        resolve({
          ok: false,
          error: `${command} exited with code ${code}: ${stderr.trim().slice(0, 300)}`,
        });
        return;
      }
      resolve(parse(stdout));
    });
  });
}
