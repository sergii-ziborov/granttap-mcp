import { StoreLockError } from "../../../../packages/core/store-file-lock";
import { PhoneLimitReached } from "../paired-phones";
import { answerableRequest, PairingIncomplete, sealForPhone, type RecoveryRequest } from "./offer";

export const REFUSAL_SCHEMA = "granttap.account-refusal.v1";
/** The phone drops a sealed answer longer than this. */
export const PHONE_ANSWER_LIMIT = 8192;

export type RefusalReason = "phone_limit" | "pairing_incomplete" | "unavailable";
export type RecoveryRefusal = {
  schema: typeof REFUSAL_SCHEMA;
  requestId: string;
  machineId: string;
  reason: RefusalReason;
  /** How many phones this computer accepts; only with phone_limit. */
  phones?: number;
};

/**
 * Why this computer cannot admit the phone that asked, or null when it should not say: the request itself
 * cannot be answered (malformed or expired), or the failure may pass (another process held the pairing lock)
 * and a later poll offers again.
 */
export function refusalFor(request: RecoveryRequest, machineId: string, error: unknown): RecoveryRefusal | null {
  if (error instanceof StoreLockError || !answerableRequest(request, machineId)) return null;
  const refusal = { schema: REFUSAL_SCHEMA, requestId: request.id, machineId } as const;
  if (error instanceof PhoneLimitReached) return { ...refusal, reason: "phone_limit", phones: error.phones };
  if (error instanceof PairingIncomplete) return { ...refusal, reason: "pairing_incomplete" };
  return { ...refusal, reason: "unavailable" };
}

/** Sealed exactly as an offer is, to the request's ephemeral phone key, so only that phone reads why. */
export function sealRefusal(refusal: RecoveryRefusal, phonePublicKey: string): string {
  const sealed = sealForPhone(refusal, phonePublicKey);
  if (Buffer.byteLength(sealed) >= PHONE_ANSWER_LIMIT) throw new Error("The sealed refusal is too large for the phone.");
  return sealed;
}
