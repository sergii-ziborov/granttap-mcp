import type { SessionInfo } from "../../../../../../packages/protocol/schema";
import { scanSessionHistory, scanSessions } from "../../../sessions";
import { deduplicateNativeSessions } from "../capabilities/session-discovery";

type Readers = {
  history: () => SessionInfo[];
  live: () => SessionInfo[];
};

/** Mesh keeps old Task identities, while current provider state stays fresh. */
export function createMeshSessionCatalog(readers: Readers = {
  history: scanSessionHistory,
  live: () => scanSessions().sessions,
}) {
  let history: SessionInfo[] | undefined;
  return {
    sessions(): SessionInfo[] {
      history ??= readers.history();
      return deduplicateNativeSessions(history, readers.live());
    },
    invalidateHistory(): void { history = undefined; },
  };
}
