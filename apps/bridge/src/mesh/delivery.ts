/**
 * Per-recipient delivery of one project message. A shared room is not
 * permission to publish, and a receipt is not an ACK unless one exists.
 */
export type DeliveryState =
  | "queued"
  | "accepted_by_runtime"
  | "submitted_to_agent"
  | "acknowledged"
  | "blocked"
  | "unsupported"
  | "offline"
  | "expired";

export type DeliveryTarget = {
  executionId: string;
  state: DeliveryState;
  reason?: string;
};

export type BroadcastPlanInput = {
  executionId: string;
  canWrite: boolean;
  paused: boolean;
  online: boolean;
};

export function planBroadcast(targets: readonly BroadcastPlanInput[]): DeliveryTarget[] {
  return targets.map((target) => {
    if (!target.online) return { executionId: target.executionId, state: "offline", reason: "endpoint offline" };
    if (target.paused) return { executionId: target.executionId, state: "blocked", reason: "execution paused" };
    if (!target.canWrite) return { executionId: target.executionId, state: "blocked", reason: "no write permission" };
    return { executionId: target.executionId, state: "queued" };
  });
}

export function retryable(target: DeliveryTarget): boolean {
  return target.state === "offline" || target.state === "expired" || target.state === "unsupported";
}

export function advanceBroadcast(
  targets: DeliveryTarget[],
  executionId: string,
  state: DeliveryState,
  reason?: string,
): DeliveryTarget[] {
  return targets.map((target) =>
    target.executionId === executionId ? { executionId, state, reason } : target);
}
