/**
 * Tell the phone every chat a listed chat started (`sessions.children`).
 *
 * A phone keeps what it was once sent: a catalog row from before runs named their parent, a Mesh Task
 * an older runtime made for each run. Counting runs on the parent does not tell the phone which of the
 * chats it keeps are such runs, so each parent in the catalog that has started any has the ids of all
 * of them sent once, again when they change (at most once a minute while a script still starts runs),
 * and again every quarter of an hour for a phone that was away. A parent with nothing new costs
 * nothing between those. Ids only; at most 4,000 a parent, newest first.
 */
import { createHash } from "node:crypto";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type { SessionInfo, SessionsChildren, SessionsStatus } from "../../../../../packages/protocol/schema";
import { lineageAgent, SESSION_ID, startedByKey, startedChildLinks, type StartedBy } from "../../started-by";
import { countedRuns } from "./ledger";

export const MAX_PUBLISHED_CHILDREN = 4_000;
/** Parents told about in one catalog tick; the rest wait for the next. */
const PARENTS_PER_TICK = 8;
const CHANGED_EVERY_MS = 60_000;
const UNCHANGED_EVERY_MS = 15 * 60_000;

/** Every chat this one is known to have started, newest first, and how many there are. */
export function startedChildIds(parent: StartedBy, max = MAX_PUBLISHED_CHILDREN): { ids: string[]; total: number } {
  const latest = new Map<string, number>();
  for (const run of countedRuns().of(parent).values()) latest.set(run.sessionId, run.at);
  for (const link of startedChildLinks(parent)) {
    latest.set(link.sessionId, Math.max(latest.get(link.sessionId) ?? 0, link.at));
  }
  const ids = [...latest.entries()].filter(([id]) => id !== parent.sessionId && SESSION_ID.test(id))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([id]) => id);
  return { ids: ids.slice(0, max), total: ids.length };
}

const told = new WeakMap<RelayClient, Map<string, { digest: string; at: number }>>();

function parentsOf(status: SessionsStatus): StartedBy[] {
  const rows: SessionInfo[] = [...status.sessions, ...(status.history ?? [])].filter((row) => row.startedChildren);
  const seen = new Set<string>();
  return rows.sort((left, right) => right.lastActivityAt - left.lastActivityAt).flatMap((row) => {
    if (!lineageAgent(row.agent)) return [];
    const parent: StartedBy = { agent: row.agent, sessionId: row.sessionId };
    if (seen.has(startedByKey(parent))) return [];
    seen.add(startedByKey(parent));
    return [parent];
  });
}

/** Send what changed for the parents in this catalog. Returns how many parents were told. */
export async function publishStartedChildren(client: RelayClient, status: SessionsStatus, now = Date.now(),
  ttlMs = 12 * 60_000): Promise<number> {
  const sent = told.get(client) ?? new Map<string, { digest: string; at: number }>();
  told.set(client, sent);
  let count = 0;
  for (const parent of parentsOf(status)) {
    if (count >= PARENTS_PER_TICK) break;
    const { ids, total } = startedChildIds(parent);
    if (ids.length === 0) continue;
    const digest = createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 24);
    const before = sent.get(startedByKey(parent));
    const wait = before?.digest === digest ? UNCHANGED_EVERY_MS : CHANGED_EVERY_MS;
    if (before && now - before.at < wait && now >= before.at) continue;
    const message: SessionsChildren = { type: "sessions.children", parent, children: ids, total, generatedAt: now };
    await client.send(message, "phone", { ttlMs, reliable: false });
    sent.set(startedByKey(parent), { digest, at: now });
    count += 1;
  }
  return count;
}
