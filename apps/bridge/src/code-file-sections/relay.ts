import type { RelayClient } from "../../../../packages/core/relay-client";
import type { ProjectCodeFileQuery } from "../../../../packages/protocol/schema";
import { loadRuntimeConfig } from "../config";
import { sendProjectPayload } from "../host/session-keys";
import { CodeFileSections } from ".";
import { defaultCodeFileDependencies } from "./analysis";
import { codeFileResult } from "./wire";

/** An answer the phone no longer waits for leaves the relay's queue after this. */
export const CODE_FILE_RESULT_TTL_MS = 5 * 60_000;
/** A query the relay held longer than this is past anyone waiting; it is taken and not answered. */
const QUERY_WINDOW_MS = 10 * 60_000;

let monitorSections: CodeFileSections | undefined;

function sections(): CodeFileSections {
  monitorSections ??= new CodeFileSections(defaultCodeFileDependencies({
    available: () => loadRuntimeConfig().meshEnabled,
  }));
  return monitorSections;
}

/**
 * `project.code_file.query`: the first answer goes to the asking phone before this returns, and an
 * analysis it needs runs on after; the relay loop never waits for it. Each answer is sealed under the
 * Project's key for that phone alone. A query over capacity throws, so the monitor's log names it.
 */
export async function handleCodeFileQuery(
  client: RelayClient, query: ProjectCodeFileQuery, peerPublicKey?: string,
  options: { sections?: CodeFileSections; now?: () => number } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  if (Math.abs(now() - query.createdAt) > QUERY_WINDOW_MS) return true;
  const admitted = await (options.sections ?? sections()).ask(query, { requestId: query.requestId, peerPublicKey },
    (recipient, answer) => sendProjectPayload(client, codeFileResult({ ...query, requestId: recipient.requestId },
      answer, now()), "phone", { peerPublicKey: recipient.peerPublicKey, ttlMs: CODE_FILE_RESULT_TTL_MS }));
  if (!admitted) throw new Error("too many code file queries are already being answered");
  return true;
}
