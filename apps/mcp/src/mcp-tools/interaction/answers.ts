import type { OperationRecord } from "../operation-ledger";
import { accountLinkStatus } from "../../../../bridge/src/account-link-state";
import { accountProblem, thisComputerUsesManagedRelay } from "../../status/account-status";
import { isMachineConfigured } from "../../status/pairing-status";

export const NOT_PAIRED = "GrantTap is not connected on this computer yet. Call connect: it signs this computer in to "
  + "GrantTap, and a phone signed in to the same account then links it by itself (a one-time QR is the fallback).";
export const RELAY_UNREACHABLE = "GrantTap could not reach its relay from this computer just now. Try again shortly; "
  + "connection_status shows the relay and account details.";
export const UNATTRIBUTED =
  "GrantTap could not attribute this call to a live agent session. Project Mesh events "
  + "are published only for the execution that made the call, so its provider hook must "
  + "be installed and trusted (granttap setup).";
export const OPERATION_CONFLICT =
  "This operationId was already used for a different call. A name means one call's arguments; "
  + "use a new operationId for a new call.";
export const STORE_BUSY =
  "The Mesh store is busy on this computer; nothing was recorded. Retry with the same operationId.";

export type ToolAnswer = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

export function answered(text: string, outcome: Record<string, unknown>): ToolAnswer {
  return { content: [{ type: "text", text }], structuredContent: outcome };
}

export function refused(text: string): ToolAnswer {
  return { isError: true, content: [{ type: "text", text }] };
}

export function replayed(record: OperationRecord): ToolAnswer {
  return answered(`${record.text}\n(replayed: this operationId was already handled)`, { ...record.outcome, replayed: true });
}

export function fromRecord(record: OperationRecord, isReplay: boolean): ToolAnswer {
  return isReplay ? replayed(record) : answered(record.text, record.outcome);
}

/**
 * Why this computer has no relay link, for a tool that needed one. It used to say "not paired" for every
 * failure, a signed-out or uncovered computer included; now the account state says which it is.
 */
export function relayUnavailableText(): string {
  const paired = isMachineConfigured();
  // Unpaired, "not signed in" is just the first step of connect, which NOT_PAIRED already names.
  const problem = accountProblem(accountLinkStatus(), paired && thisComputerUsesManagedRelay());
  if (problem) return problem;
  return paired ? RELAY_UNREACHABLE : NOT_PAIRED;
}

export function notPaired(): ToolAnswer {
  return { isError: true, content: [{ type: "text", text: relayUnavailableText() }] };
}
