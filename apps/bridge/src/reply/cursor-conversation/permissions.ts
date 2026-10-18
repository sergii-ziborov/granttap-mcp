import { z } from "zod";
import { createHash } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest } from "../../../../../packages/protocol/schema";
import { blockedSessionCapability, isSessionPaused, shouldAutoAcceptTool } from "../../config";
import { guessRisk } from "../../host/adapters";
import { protectedGrantTapAccess } from "../../host/self-protection";
import { evaluateEffectiveAction, legacyGrantTapFlowAllowed } from "../../policy/effective-action";
import { cursorInteractionId, type CursorInteractionScope } from "./questions";
import { cursorAction } from "./actions";
import { resolve } from "node:path";

export type AskCursorInteraction = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
const option = z.object({ optionId: z.string().min(1).max(256),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]), name: z.string().optional() });
const permission = z.object({ sessionId: z.string().optional(), toolCall: z.object({
  toolCallId: z.string().min(1).max(256), title: z.string().min(1).max(2_000), kind: z.string().max(64),
  rawInput: z.unknown().optional(), locations: z.array(z.object({ path: z.string().max(4_096) })).max(32).optional(),
}), options: z.array(option).min(1).max(16) });

async function actionPolicy(action: NonNullable<ReturnType<typeof cursorAction>>, scope: CursorInteractionScope,
  locations?: { path: string }[]) {
  let denied = isSessionPaused(scope.sessionId), mayAutoAllow = true;
  for (const path of locations?.length ? locations.map(location => location.path) : [undefined]) {
    const candidate = path ? { ...action.input, file_path: resolve(scope.cwd, path) } : action.input;
    const protectedAccess = protectedGrantTapAccess(action.tool, candidate, action.command);
    const blocked = blockedSessionCapability(scope.sessionId, action.tool, candidate);
    const policy = await evaluateEffectiveAction({ provider: "cursor", sessionId: scope.sessionId,
      cwd: scope.cwd, toolName: action.tool, toolInput: candidate, capability: action.capability,
      legacyDenyReason: protectedAccess?.reason ?? blocked?.reason });
    denied ||= policy.effect === "deny";
    mayAutoAllow &&= legacyGrantTapFlowAllowed(policy)
      && shouldAutoAcceptTool(scope.sessionId, action.tool, action.command, policy.projectId);
  }
  return { denied, mayAutoAllow };
}

export async function answerCursorPermission(raw: unknown, scope: CursorInteractionScope, nonce: string,
  interaction: { ask: AskCursorInteraction; signal: AbortSignal }) {
  const cancelled = { outcome: { outcome: "cancelled" as const } };
  const parsed = permission.safeParse(raw);
  if (!parsed.success || interaction.signal.aborted
    || (parsed.data.sessionId && parsed.data.sessionId !== (scope.nativeSessionId ?? scope.sessionId))) return cancelled;
  const input = parsed.data, call = input.toolCall;
  const action = cursorAction(call, scope.cwd);
  if (!action) return cancelled;
  const { tool, input: parameters, command, details } = action;
  const { denied, mayAutoAllow } = await actionPolicy(action, scope, call.locations);
  if (new Set(input.options.map(choice => choice.optionId)).size !== input.options.length) return cancelled;
  const allows = input.options.filter(choice => choice.kind === "allow_once");
  const allow = allows.length === 1 ? allows[0] : undefined;
  const reject = input.options.find(choice => choice.kind === "reject_once");
  const selected = (allowed: boolean) => {
    const choice = allowed ? allow : reject;
    return choice ? { outcome: { outcome: "selected" as const, optionId: choice.optionId } } : cancelled;
  };
  if (denied || interaction.signal.aborted) return selected(false);
  if (!allow) return cancelled;
  if (mayAutoAllow) return selected(true);
  const request: ApprovalRequest = { type: "approval.request", agent: "cursor", kind: "permission", tool,
    requestId: cursorInteractionId("permission", scope, nonce, input), title: call.title,
    command, details, inputFingerprint: createHash("sha256").update(JSON.stringify(parameters)).digest("hex"),
    sessionId: scope.sessionId, cwd: scope.cwd, risk: guessRisk(tool, command), createdAt: Date.now() };
  const decision = await interaction.ask(request, interaction.signal);
  if (interaction.signal.aborted || decision.requestId !== request.requestId
    || decision.sessionId !== scope.sessionId || decision.decision !== "allow") return selected(false);
  return selected(!(await actionPolicy(action, scope, call.locations)).denied && !interaction.signal.aborted);
}
