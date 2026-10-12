import type { RelayClient } from "../../../../packages/core/relay-client";
import { analyzeProjectGraphNow } from "../mesh/runtime";

const inFlight = new Map<string, Set<string>>();

/** One user request starts one analysis per Project, even during reconnect. */
export function requestProjectGraphRefresh(
  client: RelayClient, projectId: string,
  analyze: typeof analyzeProjectGraphNow = analyzeProjectGraphNow,
  requestId?: string,
): boolean {
  const pending = inFlight.get(projectId);
  if (pending) { if (requestId) pending.add(requestId); return false; }
  const receipts = new Set(requestId ? [requestId] : []);
  inFlight.set(projectId, receipts);
  void analyze(client, projectId, undefined, receipts).catch(() => false).finally(() => {
    inFlight.delete(projectId);
  });
  return true;
}
