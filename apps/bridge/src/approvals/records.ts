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
import type { ApprovalDecision, ApprovalRequest, ApprovalResolved } from "../../../../packages/protocol/schema";
import { configDir } from "../config";
import {
  FINGERPRINT_RE,
  MAX_PENDING_AGE_MS,
  MAX_RECORDS,
  TERMINAL_RETENTION_MS,
  UUID_V4_RE,
  WINNER_CANDIDATE_RE,
  WINNER_NAME_RE,
  type ApprovalOutcome,
  type ApprovalRecord,
  type ApprovalRegistrationHandle,
  type StoredApprovalWinner,
} from "./types";

export * from "./types";

export function recordsDir(): string {
  return join(configDir(), "approval-records");
}

export function requestDigest(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 32);
}

export function requestFingerprint(request: ApprovalRequest): string {
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

export function recordPath(requestId: string): string {
  return join(recordsDir(), `${requestDigest(requestId)}.json`);
}

export function winnerName(record: ApprovalRecord): string {
  const digest = requestDigest(record.request.requestId);
  if (!record.generation) return `${digest}.winner`;
  if (!UUID_V4_RE.test(record.generation)) throw new Error("invalid approval generation");
  return `${digest}.${record.generation.toLowerCase()}.winner`;
}

export function winnerPath(record: ApprovalRecord): string {
  return join(recordsDir(), winnerName(record));
}

export function normalizedSessionId(sessionId: string | null | undefined): string | undefined {
  const value = sessionId?.trim();
  return value || undefined;
}

export function readRecordPath(path: string): ApprovalRecord | null {
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

export function isApprovalDecision(value: unknown, record: ApprovalRecord): value is ApprovalDecision {
  const decision = value as ApprovalDecision;
  return decision?.type === "approval.decision" &&
    decision.requestId === record.request.requestId &&
    (decision.decision === "allow" || decision.decision === "deny") &&
    normalizedSessionId(decision.sessionId) === normalizedSessionId(record.request.sessionId) &&
    typeof decision.decidedAt === "number";
}

export function isApprovalOutcome(value: unknown, record: ApprovalRecord): value is ApprovalOutcome {
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

export function readWinner(record: ApprovalRecord): StoredApprovalWinner | null {
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
export function claimApprovalWinner(
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

export function advisoryWinner(record: ApprovalRecord): StoredApprovalWinner | null {
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

export function recordWinner(record: ApprovalRecord): StoredApprovalWinner | null {
  return readWinner(record) ?? advisoryWinner(record);
}

export function recordOutcome(record: ApprovalRecord): ApprovalOutcome | null {
  return recordWinner(record)?.outcome ?? null;
}

export function effectiveFingerprint(record: ApprovalRecord): string {
  return record.fingerprint ?? requestFingerprint(record.request);
}

export function registrationHandle(record: ApprovalRecord): ApprovalRegistrationHandle {
  return {
    requestId: record.request.requestId,
    sessionId: normalizedSessionId(record.request.sessionId),
    generation: record.generation ?? null,
    fingerprint: effectiveFingerprint(record),
  };
}

export function matchesRegistration(
  record: ApprovalRecord,
  expected: ApprovalRegistrationHandle | undefined,
): boolean {
  if (!expected) return true;
  return expected.requestId === record.request.requestId &&
    normalizedSessionId(expected.sessionId) === normalizedSessionId(record.request.sessionId) &&
    expected.generation === (record.generation ?? null) &&
    expected.fingerprint === effectiveFingerprint(record);
}

export function readRawRecord(requestId: string): ApprovalRecord | null {
  const path = recordPath(requestId);
  if (!existsSync(path)) return null;
  const record = readRecordPath(path);
  return record?.request.requestId === requestId ? record : null;
}

export function recordFiles(): string[] {
  try {
    return readdirSync(recordsDir())
      .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
      .map((name) => join(recordsDir(), name));
  } catch {
    return [];
  }
}

export function pruneAtomicArtifacts(now: number): void {
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

export function pruneRecords(now: number): void {
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

export function writeRecord(record: ApprovalRecord): void {
  const dir = recordsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = recordPath(record.request.requestId);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  pruneRecords(record.updatedAt);
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
