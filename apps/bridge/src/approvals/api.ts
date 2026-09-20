import { randomUUID } from "node:crypto";
import type { RelayClient } from "../../../../packages/core/relay-client";
import {
  approvalAction,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResolved,
  type ApprovalsStatus,
} from "../../../../packages/protocol/schema";
import {
  MAX_PENDING_AGE_MS,
  MAX_RECORDS,
  TERMINAL_RETENTION_MS,
  claimApprovalWinner,
  effectiveFingerprint,
  matchesRegistration,
  normalizedSessionId,
  pruneRecords,
  readRawRecord,
  readRecordPath,
  recordFiles,
  recordOutcome,
  recordWinner,
  registrationHandle,
  requestDigest,
  requestFingerprint,
  terminalApproval,
  writeRecord,
  type ApprovalAcceptance,
  type ApprovalOutcome,
  type ApprovalRecord,
  type ApprovalRegistration,
  type ApprovalRegistrationHandle,
  type ApprovalTerminalState,
  type PendingApprovalRegistration,
} from "./records";

export function registerPendingApproval(
  request: ApprovalRequest,
  now = Date.now(),
): ApprovalRegistration {
  const fingerprint = requestFingerprint(request);
  const existing = readRawRecord(request.requestId);
  const existingWinner = existing ? recordWinner(existing) : null;
  const effectiveAt = existingWinner?.acceptedAt ?? existing?.updatedAt;
  if (existing && effectiveAt != null && now - effectiveAt <= TERMINAL_RETENTION_MS) {
    if (effectiveFingerprint(existing) !== fingerprint) {
      return {
        matched: false,
        newlyRegistered: false,
        reason: "conflicting_request",
      };
    }
    return {
      matched: true,
      newlyRegistered: false,
      handle: registrationHandle(existing),
    };
  }
  const record: ApprovalRecord = {
    request,
    state: "pending",
    updatedAt: now,
    generation: randomUUID(),
    fingerprint,
  };
  writeRecord(record);
  return {
    matched: true,
    newlyRegistered: true,
    handle: registrationHandle(record),
  };
}

export function acceptApprovalDecision(
  decision: ApprovalDecision,
  now = Date.now(),
  expectedRegistration?: ApprovalRegistrationHandle,
): ApprovalAcceptance {
  const record = readRawRecord(decision.requestId);
  if (!record || !matchesRegistration(record, expectedRegistration)) {
    return { matched: false, newlyResolved: false };
  }
  const requestSessionId = normalizedSessionId(record.request.sessionId);
  const decisionSessionId = normalizedSessionId(decision.sessionId);
  if (requestSessionId !== decisionSessionId) {
    return { matched: false, newlyResolved: false };
  }
  const existingOutcome = recordOutcome(record);
  if (existingOutcome) return acceptance(record, existingOutcome, false);
  if (record.state !== "pending") return { matched: false, newlyResolved: false };
  if (now - record.updatedAt > MAX_PENDING_AGE_MS) {
    return markApprovalTerminal(
      decision.requestId,
      "expired",
      {
        decision: "deny",
        decidedBy: "system",
        note: "Approval request expired before the decision arrived",
        sessionId: requestSessionId,
      },
      now,
      expectedRegistration,
    );
  }
  const storedDecision: ApprovalDecision = {
    ...decision,
    sessionId: requestSessionId,
    decidedAt: decision.decidedAt || now,
  };
  const outcome: ApprovalOutcome = { kind: "decision", decision: storedDecision };
  const claim = claimApprovalWinner(record, outcome, now);
  if (!claim.winner) {
    // A corrupt/unreadable winner is fail-closed: do not ACK either contender.
    return { matched: false, newlyResolved: false };
  }
  if (!claim.won) {
    return acceptance(record, claim.winner.outcome, false);
  }
  return acceptance(record, claim.winner.outcome, true);
}

function acceptance(
  record: ApprovalRecord,
  outcome: ApprovalOutcome,
  newlyResolved: boolean,
): ApprovalAcceptance {
  return {
    matched: true,
    newlyResolved,
    request: record.request,
    outcome,
    decision: outcome.kind === "decision" ? outcome.decision : undefined,
  };
}

/** Read the exact-scope outcome durably accepted by another process. */
export function resolvedApprovalOutcome(
  requestId: string,
  expectedSessionId: string | null | undefined,
  expectedRegistration?: ApprovalRegistrationHandle,
): ApprovalOutcome | null {
  const record = readRawRecord(requestId);
  if (
    !record ||
    normalizedSessionId(record.request.sessionId) !== normalizedSessionId(expectedSessionId) ||
    !matchesRegistration(record, expectedRegistration)
  ) {
    return null;
  }
  return recordOutcome(record);
}

/** Read a decision only when the current request generation and exact scope match. */
export function resolvedApprovalDecision(
  requestId: string,
  expectedSessionId: string | null | undefined,
  expectedRegistration?: ApprovalRegistrationHandle,
): ApprovalDecision | null {
  const outcome = resolvedApprovalOutcome(
    requestId,
    expectedSessionId,
    expectedRegistration,
  );
  return outcome?.kind === "decision" ? outcome.decision : null;
}

export function markApprovalTerminal(
  requestId: string,
  state: ApprovalTerminalState,
  options: {
    decision?: ApprovalDecision["decision"] | null;
    decidedBy?: string | null;
    note?: string | null;
    sessionId?: string | null;
    resolvedAt?: number;
  } = {},
  now = Date.now(),
  expectedRegistration?: ApprovalRegistrationHandle,
): ApprovalAcceptance {
  const record = readRawRecord(requestId);
  if (!record || !matchesRegistration(record, expectedRegistration)) {
    return { matched: false, newlyResolved: false };
  }
  const requestSessionId = normalizedSessionId(record.request.sessionId);
  if (requestSessionId !== normalizedSessionId(options.sessionId)) {
    return { matched: false, newlyResolved: false };
  }
  const existingOutcome = recordOutcome(record);
  if (existingOutcome) return acceptance(record, existingOutcome, false);
  if (record.state !== "pending") return { matched: false, newlyResolved: false };
  const resolved = terminalApproval(requestId, state, {
    ...options,
    sessionId: requestSessionId,
    resolvedAt: options.resolvedAt ?? now,
  });
  const outcome: ApprovalOutcome = { kind: "terminal", status: state, resolved };
  const claim = claimApprovalWinner(record, outcome, now);
  if (!claim.winner) return { matched: false, newlyResolved: false };
  if (!claim.won) return acceptance(record, claim.winner.outcome, false);
  return acceptance(record, claim.winner.outcome, true);
}

export function pendingApprovalRegistrations(
  now = Date.now(),
): PendingApprovalRegistration[] {
  return recordFiles()
    .map(readRecordPath)
    .filter((record): record is ApprovalRecord =>
      record != null &&
      record.state === "pending" &&
      now - record.updatedAt <= MAX_PENDING_AGE_MS &&
      recordWinner(record) == null,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100)
    .map((record) => ({
      request: record.request,
      handle: registrationHandle(record),
    }));
}

/** Compatibility wrapper for callers that only render pending requests. */
export function pendingApprovalRequests(now = Date.now()): ApprovalRequest[] {
  return pendingApprovalRegistrations(now).map((item) => item.request);
}

function approvalScopeKey(request: Pick<ApprovalRequest, "requestId" | "sessionId">): string {
  return `${request.requestId}\u0000${normalizedSessionId(request.sessionId) ?? ""}`;
}

function coveredApprovalScopes(
  pending: ApprovalRequest[],
  now: number,
): Array<{ requestId: string; sessionId?: string }> {
  const includedPending = new Set(pending.map(approvalScopeKey));
  const covered = new Map<string, { requestId: string; sessionId?: string }>();
  for (const path of recordFiles()) {
    const record = readRecordPath(path);
    if (!record) continue;
    const winner = recordWinner(record);
    if (now - (winner?.acceptedAt ?? record.updatedAt) > TERMINAL_RETENTION_MS) continue;
    const isLivePending =
      record.state === "pending" &&
      winner == null &&
      now - record.updatedAt <= MAX_PENDING_AGE_MS;
    // Never claim an omitted live request as closed when the wire cap is hit.
    if (isLivePending && !includedPending.has(approvalScopeKey(record.request))) continue;
    const scope = {
      requestId: record.request.requestId,
      sessionId: normalizedSessionId(record.request.sessionId),
    };
    covered.set(approvalScopeKey(record.request), scope);
  }
  return [...covered.values()].slice(0, MAX_RECORDS);
}

let lastStatusGeneratedAt = 0;

export function approvalsStatus(now = Date.now()): ApprovalsStatus {
  pruneRecords(now);
  const pending = pendingApprovalRequests(now);
  const generatedAt = Math.max(Math.trunc(now), lastStatusGeneratedAt + 1);
  lastStatusGeneratedAt = generatedAt;
  return {
    type: "approvals.status",
    pending,
    complete: false,
    covered: coveredApprovalScopes(pending, now),
    actions: pending.map(approvalAction),
    generatedAt,
  };
}

export function resolvedFromDecision(
  decision: ApprovalDecision,
  request?: ApprovalRequest,
): ApprovalResolved {
  return terminalApproval(decision.requestId, "applied", {
    decision: decision.decision,
    decidedBy: decision.decidedBy,
    note: decision.note,
    sessionId: request?.sessionId ?? decision.sessionId,
    resolvedAt: decision.decidedAt,
  });
}

export function resolvedFromOutcome(
  outcome: ApprovalOutcome,
  request?: ApprovalRequest,
): ApprovalResolved {
  return outcome.kind === "decision"
    ? resolvedFromDecision(outcome.decision, request)
    : outcome.resolved;
}

export async function sendApprovalResolved(
  client: RelayClient,
  payload: ApprovalResolved,
): Promise<void> {
  await client.send(payload, "phone", {
    ttlMs: 15 * 60_000,
    wake: false,
    deliveryId: `approval-resolved-${requestDigest(payload.requestId)}`,
  });
}
