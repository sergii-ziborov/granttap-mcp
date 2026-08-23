import { createHash } from "node:crypto";
import {
  HandoffReceipt,
  TaskCapsule,
  type HandoffReceipt as HandoffReceiptValue,
  type TaskCapsule as TaskCapsuleValue,
} from "../../../../packages/protocol/schema";

export function capsuleHash(input: TaskCapsuleValue): string {
  const capsule = TaskCapsule.parse(input);
  return createHash("sha256").update(JSON.stringify(canonical(capsule))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function handoffReceipt(
  capsule: TaskCapsuleValue,
  sourceSessionId: string,
  targetSessionId: string,
  acceptedAt = Date.now(),
): HandoffReceiptValue {
  return HandoffReceipt.parse({
    sourceSessionId,
    targetSessionId,
    taskId: capsule.taskId,
    capsuleHash: capsuleHash(capsule),
    acceptedAt,
  });
}
