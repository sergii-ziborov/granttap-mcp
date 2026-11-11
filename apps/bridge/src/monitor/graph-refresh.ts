import type { RelayClient } from "../../../../packages/core/relay-client";
import { analyzeProjectGraphNow } from "../mesh/runtime";

const inFlight = new Map<string, Set<string>>();

const short = (id: string) => (id.length > 12 ? `${id.slice(0, 12)}…` : id);

/**
 * The phone's Graph spinner waits for exactly one answer. Without these lines a
 * build that never started, sent nothing or failed looked the same in the log:
 * absent. Ids are opaque Project and request ids, never paths or code.
 */
function defaultLog(line: string): void { process.stderr.write(`[monitor] ${line}\n`); }

/** One user request starts one analysis per Project, even during reconnect. */
export function requestProjectGraphRefresh(
  client: RelayClient, projectId: string,
  analyze: typeof analyzeProjectGraphNow = analyzeProjectGraphNow,
  requestId?: string,
  log: (line: string) => void = defaultLog,
  now: () => number = Date.now,
): boolean {
  const request = requestId ? ` request=${short(requestId)}` : "";
  const pending = inFlight.get(projectId);
  if (pending) {
    if (requestId) pending.add(requestId);
    log(`Graph build requested project=${short(projectId)}${request}; joined the build already running.`);
    return false;
  }
  const receipts = new Set(requestId ? [requestId] : []);
  inFlight.set(projectId, receipts);
  const started = now();
  log(`Graph build requested project=${short(projectId)}${request}; started.`);
  const seconds = () => ((now() - started) / 1000).toFixed(1);
  void analyze(client, projectId, undefined, receipts).then((answered) => {
    log(answered
      ? `Graph build project=${short(projectId)} finished in ${seconds()} s; answer sent for ${Math.max(receipts.size, 1)} request(s).`
      : `Graph build project=${short(projectId)} sent no answer after ${seconds()} s: this computer has no Mesh snapshot or bound repository for it.`);
  }, (error: unknown) => {
    const cause = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown error";
    log(`Graph build project=${short(projectId)} failed after ${seconds()} s (${cause}); the phone gets no answer.`);
  }).finally(() => {
    inFlight.delete(projectId);
  });
  return true;
}
