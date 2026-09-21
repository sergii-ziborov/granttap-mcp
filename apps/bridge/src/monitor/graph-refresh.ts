import type { RelayClient } from "../../../../packages/core/relay-client";
import { analyzeProjectGraphNow } from "../mesh/runtime";

const inFlight = new Set<string>();

/** One user request starts one analysis per Project, even during reconnect. */
export function requestProjectGraphRefresh(
  client: RelayClient, projectId: string,
  analyze: typeof analyzeProjectGraphNow = analyzeProjectGraphNow,
): boolean {
  if (inFlight.has(projectId)) return false;
  inFlight.add(projectId);
  void analyze(client, projectId).catch(() => false).finally(() => {
    inFlight.delete(projectId);
  });
  return true;
}
