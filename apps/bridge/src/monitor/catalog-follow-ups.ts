import type { SessionsStatus } from "../../../../packages/protocol/schema";
import { refreshMcpLoad } from "../machine-load/mcp/refresh";
import { scheduleLimitContinuations } from "../limit-continuation";
import { scheduleAutoCompactions } from "../context-compaction";
import { keepNotedChatPictures } from "../helper-runs/pictures/chats";
import { cachedNativeAccountUsage } from "../provider-account-status";

/**
 * The work each catalog the leader published starts in the background. None of it holds the next
 * catalog back, and a failure in one never stops the others.
 */
export function startCatalogFollowUps(status: SessionsStatus): void {
  void refreshMcpLoad(status.sessions).catch(() => {});
  // A weekly limit resets long after its chat has left the live list, so history is looked at too.
  void scheduleLimitContinuations([...status.sessions, ...(status.history ?? [])], undefined, Date.now(),
    cachedNativeAccountUsage).catch(() => {});
  // Between turns only: a chat whose last turn took it over its threshold is compacted now.
  void scheduleAutoCompactions(status.sessions).catch(() => {});
  void keepNotedChatPictures().catch(() => {});
}
