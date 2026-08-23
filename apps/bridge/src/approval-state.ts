/**
 * Durable approval state shared with the desktop bridge.
 *
 * The on-disk record shape and directory intentionally match nodvox's bridge,
 * so its long-running monitor can publish an authoritative snapshot for MCP
 * asks created by this separate process.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RelayClient } from "../../../packages/core/relay-client";
import {
  approvalAction,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResolved,
  type ApprovalsStatus,
} from "../../../packages/protocol/schema";
import { configDir } from "./config";

const MAX_RECORDS = 300;
const MAX_PENDING_AGE_MS = 5 * 60_000;
const TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
const UUID_V4_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_V4_RE = new RegExp(`^${UUID_V4_PATTERN}$`, "i");
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const WINNER_NAME_RE = new RegExp(
  `^([a-f0-9]{32})(?:\\.(${UUID_V4_PATTERN}))?\\.winner$`,
  "i",
);
const WINNER_CANDIDATE_RE = new RegExp(
  `^(([a-f0-9]{32})(?:\\.${UUID_V4_PATTERN})?\\.winner)\\.[0-9]+\\.${UUID_V4_PATTERN}\\.tmp$`,
  "i",
);

type ApprovalRecord = {
  request: ApprovalRequest;
  state: "pending" | "resolved" | "cancelled" | "expired";
  updatedAt: number;
  generation?: string;
  fingerprint?: string;
  decision?: ApprovalDecision;
};

type ApprovalTerminalState = "cancelled" | "expired";

export type ApprovalOutcome =
  | { kind: "decision"; decision: ApprovalDecision }
  | { kind: "terminal"; status: ApprovalTerminalState; resolved: ApprovalResolved };

export type ApprovalAcceptance = {
  matched: boolean;
  newlyResolved: boolean;
  request?: ApprovalRequest;
  outcome?: ApprovalOutcome;
  decision?: ApprovalDecision;
};

export type ApprovalRegistrationHandle = {
  requestId: string;
  sessionId?: string;
  generation: string | null;
  fingerprint: string;
};

export type ApprovalRegistration =
  | {
      matched: true;
      newlyRegistered: boolean;
      handle: ApprovalRegistrationHandle;
    }
  | {
      matched: false;
      newlyRegistered: false;
      reason: "conflicting_request";
    };

export type PendingApprovalRegistration = {
  request: ApprovalRequest;
  handle: ApprovalRegistrationHandle;
};

type StoredApprovalWinner = {
  version: 1;
  requestId: string;
  sessionId?: string;
  generation: string | null;
  acceptedAt: number;
  outcome: ApprovalOutcome;
};

function recordsDir(): string {
  return join(configDir(), "approval-records");
}

function requestDigest(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 32);
}

function requestFingerprint(request: ApprovalRequest): string {
  const stable = JSON.stringify([
    request.type,
    request.requestId,
    request.agent,
    request.kind,
    request.tool,
    request.title,
    request.command ?? null,
    request.cwd ?? null,
    normalizedSessionId(request.sessionId) ?? null,
    request.risk,
  ]);
  return createHash("sha256").update(stable).digest("hex");
}

function recordPath(requestId: string): string {
  return join(recordsDir(), `${requestDigest(requestId)}.json`);
}

function winnerName(record: ApprovalRecord): string {
  const digest = requestDigest(record.request.requestId);
  if (!record.generation) return `${digest}.winner`;
  if (!UUID_V4_RE.test(record.generation)) throw new Error("invalid approval generation");
  return `${digest}.${record.generation.toLowerCase()}.winner`;
}

function winnerPath(record: ApprovalRecord): string {
  return join(recordsDir(), winnerName(record));
}

function normalizedSessionId(sessionId: string | null | undefined): string | undefined {
  const value = sessionId?.trim();
  return value || undefined;
}

function readRecordPath(path: string): ApprovalRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ApprovalRecord;
    if (
      !value ||
      typeof value !== "object" ||
      !value.request ||
      typeof value.request.requestId !== "string" ||
      typeof value.updatedAt !== "number" ||
      (value.generation != null &&
        (typeof value.generation !== "string" || !UUID_V4_RE.test(value.generation))) ||
      (value.fingerprint != null &&
        (typeof value.fingerprint !== "string" || !FINGERPRINT_RE.test(value.fingerprint))) ||
      !["pending", "resolved", "cancelled", "expired"].includes(value.state)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isApprovalDecision(value: unknown, record: ApprovalRecord): value is ApprovalDecision {
  const decision = value as ApprovalDecision;
  return decision?.type === "approval.decision" &&
    decision.requestId === record.request.requestId &&
    (decision.decision === "allow" || decision.decision === "deny") &&
    normalizedSessionId(decision.sessionId) === normalizedSessionId(record.request.sessionId) &&
    typeof decision.decidedAt === "number";
}

function isApprovalOutcome(value: unknown, record: ApprovalRecord): value is ApprovalOutcome {
  const outcome = value as ApprovalOutcome;
  if (outcome?.kind === "decision") return isApprovalDecision(outcome.decision, record);
  if (outcome?.kind !== "terminal") return false;
  const resolved = outcome.resolved;
  return (outcome.status === "cancelled" || outcome.status === "expired") &&
    resolved?.type === "approval.resolved" &&
    resolved.requestId === record.request.requestId &&
    resolved.status === outcome.status &&
    normalizedSessionId(resolved.sessionId) === normalizedSessionId(record.request.sessionId) &&
    typeof resolved.resolvedAt === "number";
}

function readWinner(record: ApprovalRecord): StoredApprovalWinner | null {
  try {
    const value = JSON.parse(readFileSync(winnerPath(record), "utf8")) as unknown;
    // Compatibility with decision-only winner files written before outcome CAS.
    if (!record.generation && isApprovalDecision(value, record)) {
      return {
        version: 1,
        requestId: record.request.requestId,
        sessionId: normalizedSessionId(record.request.sessionId),
        generation: null,
        // Legacy raw winners have no trusted local acceptance timestamp.
        // Retention must use the machine-written record, never phone clock data.
        acceptedAt: record.updatedAt,
        outcome: { kind: "decision", decision: value },
      };
    }
    const winner = value as StoredApprovalWinner;
    if (
      winner?.version !== 1 ||
      winner.requestId !== record.request.requestId ||
      winner.generation !== (record.generation ?? null) ||
      normalizedSessionId(winner.sessionId) !== normalizedSessionId(record.request.sessionId) ||
      typeof winner.acceptedAt !== "number" ||
      !isApprovalOutcome(winner.outcome, record)
    ) {
      return null;
    }
    return winner;
  } catch {
    return null;
  }
}

/**
 * The hard-link is the linearization point: all contenders write complete,
 * private candidates, but exactly one can link its candidate to `.winner`.
 * There is no lock or post-claim advisory rewrite to strand after a crash; the
 * immutable winner remains the sole authority for this exact generation.
 */
function claimApprovalWinner(
  record: ApprovalRecord,
  outcome: ApprovalOutcome,
  now: number,
): {
  won: boolean;
  winner: StoredApprovalWinner | null;
} {
  const dir = recordsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = winnerPath(record);
  const candidate = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const winner: StoredApprovalWinner = {
    version: 1,
    requestId: record.request.requestId,
    sessionId: normalizedSessionId(record.request.sessionId),
    generation: record.generation ?? null,
    acceptedAt: now,
    outcome,
  };
  try {
    writeFileSync(candidate, `${JSON.stringify(winner)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    try {
      linkSync(candidate, target);
      chmodSync(target, 0o600);
      return { won: true, winner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return { won: false, winner: readWinner(record) };
    }
  } finally {
    try {
      unlinkSync(candidate);
    } catch {
      /* candidate may not have been created; winner remains immutable */
    }
  }
}

function advisoryWinner(record: ApprovalRecord): StoredApprovalWinner | null {
  let outcome: ApprovalOutcome | null = null;
  if (record.state === "resolved" && record.decision) {
    outcome = { kind: "decision", decision: record.decision };
  } else if (record.state === "cancelled" || record.state === "expired") {
    outcome = {
      kind: "terminal",
      status: record.state,
      resolved: terminalApproval(record.request.requestId, record.state, {
        sessionId: record.request.sessionId,
        resolvedAt: record.updatedAt,
      }),
    };
  }
  return outcome ? {
    version: 1,
    requestId: record.request.requestId,
    sessionId: normalizedSessionId(record.request.sessionId),
    generation: record.generation ?? null,
    acceptedAt: record.updatedAt,
    outcome,
  } : null;
}

function recordWinner(record: ApprovalRecord): StoredApprovalWinner | null {
  return readWinner(record) ?? advisoryWinner(record);
}

function recordOutcome(record: ApprovalRecord): ApprovalOutcome | null {
  return recordWinner(record)?.outcome ?? null;
}

function effectiveFingerprint(record: ApprovalRecord): string {
  return record.fingerprint ?? requestFingerprint(record.request);
}

function registrationHandle(record: ApprovalRecord): ApprovalRegistrationHandle {
  return {
    requestId: record.request.requestId,
    sessionId: normalizedSessionId(record.request.sessionId),
    generation: record.generation ?? null,
    fingerprint: effectiveFingerprint(record),
  };
}

function matchesRegistration(
  record: ApprovalRecord,
  expected: ApprovalRegistrationHandle | undefined,
): boolean {
  if (!expected) return true;
  return expected.requestId === record.request.requestId &&
    normalizedSessionId(expected.sessionId) === normalizedSessionId(record.request.sessionId) &&
    expected.generation === (record.generation ?? null) &&
    expected.fingerprint === effectiveFingerprint(record);
}

function readRawRecord(requestId: string): ApprovalRecord | null {
  const path = recordPath(requestId);
  if (!existsSync(path)) return null;
  const record = readRecordPath(path);
  return record?.request.requestId === requestId ? record : null;
}

function recordFiles(): string[] {
  try {
    return readdirSync(recordsDir())
      .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
      .map((name) => join(recordsDir(), name));
  } catch {
    return [];
  }
}

function pruneAtomicArtifacts(now: number): void {
  let names: string[];
  try {
    names = readdirSync(recordsDir());
  } catch {
    return;
  }
  for (const name of names) {
    const winner = name.match(WINNER_NAME_RE);
    const candidate = name.match(WINNER_CANDIDATE_RE);
    if (!winner && !candidate) continue;
    const path = join(recordsDir(), name);
    try {
      const age = now - statSync(path).mtimeMs;
      const digest = winner?.[1] ?? candidate![2];
      const record = readRecordPath(join(recordsDir(), `${digest}.json`));
      const currentWinner = record ? winnerName(record) : null;
      const artifactWinner = winner ? name : candidate![1];
      const belongsToCurrentRecord = currentWinner === artifactWinner;
      // Candidates are never read after link(); a process killed before finally
      // cannot strand resolution. Orphan winners are safe to reap once no
      // matching record can possibly be in flight.
      const staleCandidate = candidate != null && age > 60_000;
      const orphanWinner = winner != null && !belongsToCurrentRecord && age > 60_000;
      if (staleCandidate || orphanWinner) unlinkSync(path);
    } catch {
      /* concurrent writer/pruner won the race */
    }
  }
}

function pruneRecords(now: number): void {
  const records = recordFiles()
    .map((path) => {
      const record = readRecordPath(path);
      return record ? { path, record, winner: recordWinner(record) } : null;
    })
    .filter((item): item is {
      path: string;
      record: ApprovalRecord;
      winner: StoredApprovalWinner | null;
    } => item != null)
    .sort((a, b) =>
      (b.winner?.acceptedAt ?? b.record.updatedAt) -
      (a.winner?.acceptedAt ?? a.record.updatedAt));
  for (const [index, item] of records.entries()) {
    // Keep every registration tombstone for the shared 24-hour replay window,
    // including a winner whose advisory record still says pending. The pending
    // wire list independently expires at five minutes.
    if (
      index < MAX_RECORDS &&
      now - (item.winner?.acceptedAt ?? item.record.updatedAt) <= TERMINAL_RETENTION_MS
    ) {
      continue;
    }
    try {
      unlinkSync(item.path);
    } catch {
      /* best-effort bounded cleanup */
    }
    try {
      unlinkSync(winnerPath(item.record));
    } catch {
      /* a pending/cancelled record normally has no winner */
    }
  }
  pruneAtomicArtifacts(now);
}

function writeRecord(record: ApprovalRecord): void {
  const dir = recordsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = recordPath(record.request.requestId);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  pruneRecords(record.updatedAt);
}

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

export function terminalApproval(
  requestId: string,
  status: ApprovalResolved["status"],
  options: {
    decision?: ApprovalDecision["decision"] | null;
    decidedBy?: string | null;
    note?: string | null;
    sessionId?: string | null;
    resolvedAt?: number;
  } = {},
): ApprovalResolved {
  return {
    type: "approval.resolved",
    requestId,
    status,
    decision: options.decision,
    decidedBy: options.decidedBy,
    note: options.note,
    sessionId: options.sessionId,
    resolvedAt: options.resolvedAt ?? Date.now(),
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
