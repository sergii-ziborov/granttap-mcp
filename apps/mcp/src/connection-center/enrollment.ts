/**
 * A QR is one enrollment attempt. An already-paired phone's heartbeat is not
 * that attempt succeeding, and mailbox expiry is not a join.
 */
import { randomId } from "../../../../packages/core/crypto";

export type EnrollmentAttempt = {
  attemptId: string;
  room: string;
  issuedAt: number;
  peerPublicKey: string | null;
};

let current: EnrollmentAttempt | null = null;

export function beginEnrollment(input: { room: string; peerPublicKey?: string | null }): EnrollmentAttempt {
  current = {
    attemptId: randomId(8),
    room: input.room,
    issuedAt: Date.now(),
    peerPublicKey: input.peerPublicKey ?? null,
  };
  return current;
}

export function currentEnrollment(): EnrollmentAttempt | null {
  return current;
}

export function enrollmentIsOpen(attemptId?: string): boolean {
  return current != null && (attemptId == null || current.attemptId === attemptId);
}

/** True when a new endpoint identity finished this attempt. Same peer is ignored. */
export function completeEnrollment(peerPublicKey: string): boolean {
  if (!current) return false;
  if (current.peerPublicKey && current.peerPublicKey === peerPublicKey) return false;
  current = null;
  return true;
}

export function cancelEnrollment(): void {
  current = null;
}
