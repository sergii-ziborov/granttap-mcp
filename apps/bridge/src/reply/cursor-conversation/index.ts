import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SessionInfo } from "../../../../../packages/protocol/schema";
import type { ReplyResult } from "../payload/types";
import { prepareCursorAcpContinuation, cursorHasRetainedConversation } from "../cursor-context";
import { beginCursorTurn, cursorExecution, saveCursorExecution } from "../../sessions/cursor";
import { resolveCursorAgentBin } from "../process/cursor-agent-bin";
import { CursorRpc } from "./transport";
import { cursorInteractions } from "./interactions";
import type { AskCursorInteraction } from "./permissions";
import { CursorCallContext } from "./call-context";

/** Interactive Cursor turns keep native permission/question RPCs alive until the person answers. */
export async function runCursorConversation(options: { session?: SessionInfo; cwd: string; text: string;
  timeoutMs: number; model?: string; mode?: "agent" | "plan" | "ask";
  operationKey?: string; ask?: AskCursorInteraction; onNativeSession?: (id: string) => void }): Promise<ReplyResult> {
  let sessionId = options.session?.sessionId ?? "";
  let nativeSessionId = sessionId;
  let response = "";
  let conversation: ReturnType<typeof beginCursorTurn> | undefined;
  const calls = new CursorCallContext();
  const onRequest = cursorInteractions(() => ({ sessionId, nativeSessionId, cwd: options.cwd }), randomUUID(), options.timeoutMs, options.ask);
  const rpc = new CursorRpc({ command: resolveCursorAgentBin(), cwd: options.cwd, timeoutMs: options.timeoutMs,
    key: options.session?.sessionId ?? options.operationKey,
    args: ["--trust", ...(options.model ? ["--model", options.model] : []), "acp"],
    onRequest: async (method, params, signal) => {
      conversation?.state("waiting");
      try { return await onRequest(method,
        method === "session/request_permission" ? calls.permission(params, nativeSessionId) : params, signal); }
      finally { conversation?.state("working"); }
    },
    onUpdate: raw => {
      calls.remember(raw, nativeSessionId);
      if (!raw || typeof raw !== "object") return;
      const value = raw as { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } };
      if (value.sessionId !== nativeSessionId) return;
      if (['tool_call', 'tool_call_update'].includes(value.update?.sessionUpdate ?? '')) {
        conversation?.tool(value.update);
        if (value.update?.sessionUpdate === 'tool_call') response = '';
        return;
      }
      if (value.update?.sessionUpdate !== "agent_message_chunk") return;
      if (value.update.content?.type === "text" && typeof value.update.content.text === "string") {
        response = (response + value.update.content.text).slice(-32_000);
        conversation?.update(response);
      }
    } });
  try {
    const init = await rpc.request("initialize", { protocolVersion: 1,
      clientInfo: { name: "GrantTap", version: JSON.parse(readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8")).version },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }) as { agentCapabilities?: { loadSession?: boolean } };
    // Existing CLI authentication is reused. GrantTap never starts a provider login flow.
    let context: ReturnType<typeof prepareCursorAcpContinuation> | undefined;
    if (options.session) {
      if (!init?.agentCapabilities?.loadSession) throw new Error("This Cursor version cannot resume an interactive task");
      const execution = cursorExecution(sessionId, options.cwd);
      const knownIde = cursorHasRetainedConversation(sessionId);
      if (execution || knownIde) context = prepareCursorAcpContinuation(options.session, options.text);
      if (!execution && knownIde) {
        const created = await rpc.request("session/new", { cwd: options.cwd, mcpServers: [] }) as { sessionId?: string };
        if (!created?.sessionId || created.sessionId.length > 256) throw new Error("Cursor did not create a scoped execution");
        nativeSessionId = created.sessionId;
        saveCursorExecution({ sessionId, nativeSessionId, cwd: options.cwd });
      } else {
        nativeSessionId = execution?.nativeSessionId ?? sessionId;
        if (execution) saveCursorExecution(execution);
        await rpc.request("session/load", { sessionId: nativeSessionId, cwd: options.cwd, mcpServers: [] });
      }
      rpc.track(nativeSessionId);
    } else {
      const created = await rpc.request("session/new", { cwd: options.cwd, mcpServers: [] }) as { sessionId?: string };
      if (!created?.sessionId || created.sessionId.length > 256) throw new Error("Cursor did not create a scoped session");
      sessionId = nativeSessionId = created.sessionId; rpc.track(sessionId);
      options.onNativeSession?.(sessionId);
    }
    if (options.mode) await rpc.request("session/set_mode", { sessionId: nativeSessionId, modeId: options.mode });
    response = ""; // Loading history never becomes a new answer to the current message.
    conversation = beginCursorTurn({ sessionId, cwd: options.cwd, text: options.text,
      session: options.session, model: options.model });
    const result = await rpc.request("session/prompt", { sessionId: nativeSessionId,
      prompt: [{ type: "text", text: context?.prompt ?? options.text }] }, options.timeoutMs) as { stopReason?: string };
    if (result?.stopReason !== "end_turn") throw new Error("Cursor stopped before completing this task turn");
    if (!response.trim()) throw new Error("Cursor returned no visible answer");
    context?.complete();
    try { conversation.finish(); } catch { /* A completed provider turn must not be retried after a history write failure. */ }
    return { ok: true, text: response.trim().slice(-4_000), sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Cursor conversation could not continue";
    try { conversation?.finish(message); } catch { /* Delivery still returns the original failure. */ }
    return { ok: false, error: message };
  }
  finally { rpc.close(); }
}
