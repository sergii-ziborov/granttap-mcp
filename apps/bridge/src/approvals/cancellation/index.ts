import type { ApprovalRequest } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { markApprovalTerminal, resolvedFromOutcome, sendApprovalResolved, type ApprovalRegistrationHandle } from "../state";

/** Stop showing a provider interaction when its exact waiting process has ended. */
export function attachApprovalCancellation(client: RelayClient, request: ApprovalRequest, options: {
  signal?: AbortSignal; handle?: ApprovalRegistrationHandle; cancel: () => void; close?: () => void;
}): () => void {
  const abort = () => {
    try {
      const terminal = markApprovalTerminal(request.requestId, "cancelled", { decision: "deny",
        decidedBy: "cancelled", note: "The agent stopped waiting for this answer.", sessionId: request.sessionId }, Date.now(), options.handle);
      if (terminal.outcome) void sendApprovalResolved(client, resolvedFromOutcome(terminal.outcome, terminal.request)).catch(() => {});
    } catch { /* Storage failure must still release the owned provider waiter. */ }
    finally { options.cancel(); options.close?.(); }
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return () => options.signal?.removeEventListener("abort", abort);
}
