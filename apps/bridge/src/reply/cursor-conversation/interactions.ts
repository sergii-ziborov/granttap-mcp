import { z } from "zod";
import { requestApproval } from "../../approvals";
import { loadConfig, machineConfigPath } from "../../config";
import type { AskCursorInteraction } from "./permissions";
import { answerCursorPermission } from "./permissions";
import { cursorInteractionId, cursorQuestionRequest, cursorQuestionResult, type CursorInteractionScope } from "./questions";

const plan = z.object({ toolCallId: z.string().min(1).max(256), name: z.string().max(160).optional(),
  overview: z.string().max(2_000).optional(), plan: z.string().min(1).max(16_384) });

export function cursorInteractions(scope: () => CursorInteractionScope, nonce: string, timeoutMs: number,
  ask: AskCursorInteraction = (request, signal) => requestApproval(loadConfig(machineConfigPath()), request, { timeoutMs, signal })) {
  return async (rawMethod: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
    const method = rawMethod.startsWith("_cursor/") ? rawMethod.slice(1) : rawMethod;
    const cancelled = { outcome: { outcome: "cancelled" } }, current = scope();
    const suppliedSession = params && typeof params === "object" ? (params as { sessionId?: unknown }).sessionId : undefined;
    if (signal.aborted || !current.sessionId
      || (suppliedSession !== undefined && suppliedSession !== (current.nativeSessionId ?? current.sessionId))) return cancelled;
    if (method === "session/request_permission") return answerCursorPermission(params, current, nonce, { ask, signal });
    if (method === "cursor/ask_question") {
      let request;
      try { request = cursorQuestionRequest(params, current, nonce); } catch { return cancelled; }
      const decision = await ask(request, signal);
      return signal.aborted ? cancelled : cursorQuestionResult(params, request, decision);
    }
    if (method === "cursor/create_plan") {
      const parsed = plan.safeParse(params); if (!parsed.success) return cancelled;
      const input = parsed.data;
      const request = { type: "approval.request" as const, agent: "cursor", kind: "permission" as const,
        tool: "Plan", title: input.name ?? "Review Cursor plan", details: input.plan,
        requestId: cursorInteractionId("plan", current, nonce, input), sessionId: current.sessionId,
        cwd: current.cwd, risk: "low" as const, createdAt: Date.now() };
      const decision = await ask(request, signal);
      return { outcome: { outcome: !signal.aborted && decision.requestId === request.requestId
        && decision.sessionId === current.sessionId && decision.decision === "allow" ? "accepted" : "rejected" } };
    }
    throw new Error("Unsupported Cursor interaction");
  };
}
