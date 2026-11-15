/**
 * One answer per edit request. A phone that did not hear back asks again
 * with the same request id; it is given the answer the first request got,
 * and the edit is not made twice. A different edit under a used id is not
 * answered at all.
 */
import { createHash } from "node:crypto";
import type { MeshRepositoryEdit, MeshRepositoryEditResult } from "../../../../../packages/protocol/schema";

export const EDIT_MEMORY_MS = 10 * 60_000;
export const MAX_REMEMBERED_EDITS = 128;

type Entry = { fingerprint: string; at: number; result: Promise<MeshRepositoryEditResult> };

export type EditRecall =
  | { kind: "new"; remember: (result: Promise<MeshRepositoryEditResult>) => void }
  | { kind: "replay"; result: Promise<MeshRepositoryEditResult> }
  | { kind: "conflict" };

/** What makes two requests the same edit: not when they were sent, only what they ask. */
export function editFingerprint(request: MeshRepositoryEdit): string {
  return createHash("sha256").update(JSON.stringify([
    request.projectId, request.action, request.path ?? null, request.bindingId ?? null,
  ])).digest("hex");
}

export class EditRequests {
  private readonly entries = new Map<string, Entry>();

  recall(scope: string, request: MeshRepositoryEdit, now: number): EditRecall {
    for (const [key, entry] of this.entries) if (now - entry.at > EDIT_MEMORY_MS) this.entries.delete(key);
    const key = `${scope}\0${request.requestId}`;
    const fingerprint = editFingerprint(request);
    const known = this.entries.get(key);
    if (known) return known.fingerprint === fingerprint ? { kind: "replay", result: known.result } : { kind: "conflict" };
    return {
      kind: "new",
      remember: (result) => {
        // The oldest answer gives way; Map keeps insertion order.
        while (this.entries.size >= MAX_REMEMBERED_EDITS) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, { fingerprint, at: now, result });
      },
    };
  }

  clear(): void {
    this.entries.clear();
  }
}
