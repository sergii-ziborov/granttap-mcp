import type { SessionInfo } from "../../../../../packages/protocol/schema";
import { loadRuntimeConfig } from "../../config";
import { resolveCodexBinary } from "../../providers/codex-bin";
import { runProcess } from ".";
import { providerEffortArgs } from "./provider-effort";
import type { DeliveryOptions, ReplyResult } from "../payload/types";
import { deliverToCodexDesktop } from '../../codex-desktop';

function parseCodexJsonl(stdout: string, fallbackSessionId?: string): ReplyResult {
  let lastMessage = "";
  let sessionId = fallbackSessionId;
  let structured = false;
  let failure = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        thread_id?: string;
        session_id?: string;
        item?: { type?: string; text?: string; message?: string };
        error?: { message?: string } | string;
      };
      structured = true;
      if (event.type === "thread.started") {
        sessionId = event.thread_id ?? event.session_id ?? sessionId;
      }
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        lastMessage = event.item.text;
      }
      if (event.type === "error" || event.type === "turn.failed" || event.item?.type === "error") {
        failure = (typeof event.error === "string" ? event.error : event.error?.message)
          ?? event.item?.message ?? "Codex reported an error.";
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  if (failure) return { ok: false, error: failure.slice(0, 500) };
  if (lastMessage) return { ok: true, text: lastMessage.slice(0, 4000), sessionId };
  if (structured) return { ok: false, error: "Codex returned no agent message." };
  const trimmed = stdout.trim();
  return trimmed
    ? { ok: true, text: trimmed.slice(0, 4000), sessionId }
    : { ok: false, error: "Codex returned an empty response." };
}

export async function runCodex(
  session: SessionInfo,
  text: string,
  timeoutMs: number,
  images: string[] = [],
  options: DeliveryOptions = {},
): Promise<ReplyResult> {
  const native = await deliverToCodexDesktop({ session, text, images, options, timeoutMs });
  if (native) return native;
  if (options.nativeOnly) return { ok: false, error: 'Open this conversation in Codex to answer its question.' };
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
  const modelArgs = options.model ? ["-m", options.model] : [];
  const imageArgs = images.flatMap((path) => ["-i", path]);
  const args = [
    "exec", "resume", ...accessArgs, ...mcpArgs, ...modelArgs, ...providerEffortArgs("codex", options.effort), ...imageArgs,
    session.sessionId, "--json", "-",
  ];
  const result = await runProcess(
    resolveCodexBinary(),
    args,
    session.cwd,
    timeoutMs,
    (stdout) => parseCodexJsonl(stdout, session.sessionId),
    text,
    session.sessionId,
  );
  return !result.ok && /thread-store conflict|already has an active writer/i.test(result.error)
    ? { ok: false, error: 'Codex already owns this chat. Keep its window open and retry the message in GrantTap.' }
    : result;
}

function tomlKey(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function runCodexNew(
  text: string,
  cwd: string,
  timeoutMs: number,
  images: string[] = [],
  model?: string,
  operationKey?: string,
  effort?: string,
): Promise<ReplyResult> {
  // This is the supported non-interactive Codex path. It preserves the user's
  // normal sandbox, approval, hooks, model, and auth configuration.
  const imageArgs = images.flatMap((path) => ["-i", path]);
  const args = ["exec", ...(model ? ["-m", model] : []), ...providerEffortArgs("codex", effort), ...imageArgs,
    "--json", "--skip-git-repo-check", "-"];
  return runProcess(resolveCodexBinary(), args, cwd, timeoutMs, parseCodexJsonl, text, operationKey);
}
