import type { OperationRecord } from "../operation-ledger";

export const NOT_PAIRED =
  "GrantTap is not paired on this machine. Pair the desktop bridge with the GrantTap app first.";
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

export function notPaired(): ToolAnswer {
  return { isError: true, content: [{ type: "text", text: NOT_PAIRED }] };
}
