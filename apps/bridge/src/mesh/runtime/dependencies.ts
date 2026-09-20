/** The seams the Mesh runtime needs from this computer: state, sessions, git, and transport. */
import type { RelayClient } from "../../../../../packages/core/relay-client";
import type {
  MeshEvent,
  MeshProvider,
  MeshSnapshot,
  SessionInfo,
} from "../../../../../packages/protocol/schema";
import type { createCodexSession, deliverToSession } from "../../reply";
import type { MeshStore } from "../store";
import type { createHandoffWorktree } from "./worktree";

type StartResult = Awaited<ReturnType<typeof createCodexSession>>;
type WorktreeResult = NonNullable<ReturnType<typeof createHandoffWorktree>>;

export type MeshRuntimeDependencies = {
  store: () => MeshStore;
  sessions: () => SessionInfo[];
  computer: () => string;
  now: () => number;
  eventId: () => string;
  providerEnabled: (provider: Exclude<MeshProvider, "grok_bot">) => boolean;
  start: (provider: MeshProvider, prompt: string, cwd: string) => Promise<StartResult>;
  deliver: typeof deliverToSession;
  send: (
    client: RelayClient,
    payload: MeshEvent | MeshSnapshot,
    options: { ttlMs: number; wake?: boolean },
  ) => Promise<void>;
  worktree: (
    repository: string,
    taskId: string,
    provider: MeshProvider,
    revision: string,
  ) => WorktreeResult | undefined | null;
  hasCommit: (repository: string, revision: string) => boolean;
  /** Publish the branch a capsule names, when the person asked for it. */
  push: (cwd: string, branch: string | undefined) => { ok: true; remote: string } | { ok: false; error: string };
  /** Bring a commit the capsule names to this checkout; whether it is here now. */
  fetch: (repository: string, revision: string, branch?: string) => boolean;
};
