/**
 * A Task sent to a provider cloud runner through the computer that holds it.
 *
 * The computer pushes (or finds already pushed) the branch the capsule names,
 * starts the run with the installed CLI, and records it as an external
 * execution of the Task with the link the CLI printed. GrantTap cannot see a
 * cloud run's progress, so it reports none.
 */
import type { RelayClient } from "../../../../../../packages/core/relay-client";
import type { MeshEvent, MeshHandoffPrepare, SessionInfo, TaskCapsule } from "../../../../../../packages/protocol/schema";
import { startCloudRunner } from "../../../cloud-runners";
import { remoteHasCommit } from "../../local-remote/remote";
import type { MeshRuntimeDependencies } from "../dependencies";
import { composeMeshSnapshot } from "../snapshot/compose";

type Block = (client: RelayClient, request: MeshHandoffPrepare, reason: string) => Promise<void>;
const DAY = 24 * 60 * 60_000;

/** The pushed revision the cloud runner will fetch, or why it cannot. */
function publishedRevision(deps: MeshRuntimeDependencies, request: MeshHandoffPrepare, cwd: string,
  capsule: TaskCapsule): string | undefined {
  const revision = capsule.latestCommit ?? capsule.baseSha;
  if (!revision) return "A cloud runner requires a Git commit.";
  if (request.push) {
    const pushed = deps.push(cwd, capsule.branch);
    return pushed.ok ? undefined : pushed.error;
  }
  if ((deps.remoteHasCommit ?? remoteHasCommit)(cwd, revision)) return undefined;
  return `The cloud runner fetches ${capsule.branch ?? "the branch"} from the repository's remote, which does not `
    + `have ${revision.slice(0, 12)} yet. Turn on pushing the branch, or push it yourself.`;
}

function startedEvent(deps: MeshRuntimeDependencies, request: MeshHandoffPrepare, summary: string): MeshEvent {
  const createdAt = deps.now();
  return { type: "mesh.event", sessionId: request.taskId, eventId: deps.eventId(), projectId: request.projectId,
    taskId: request.taskId, sourceSessionId: request.sessionId, eventType: "TASK_PROGRESS", createdAt,
    expiresAt: createdAt + DAY, payload: { summary: summary.slice(0, 1_000) } };
}

export async function prepareCloudHandoff(input: {
  deps: MeshRuntimeDependencies; block: Block; client: RelayClient;
  request: MeshHandoffPrepare; session: SessionInfo; capsule: TaskCapsule;
}): Promise<boolean> {
  const { deps, block, client, request, session, capsule } = input;
  const provider = request.targetProvider;
  const cwd = session.worktree ?? session.cwd;
  if ((provider !== "claude" && provider !== "codex") || request.targetComputer !== deps.computer() || !cwd) {
    await block(client, request, "A cloud runner starts from the computer that holds this Task. Choose the runner under that computer.");
    return false;
  }
  const unpublished = publishedRevision(deps, request, cwd, capsule);
  if (unpublished) {
    await block(client, request, unpublished);
    return false;
  }
  const launched = await (deps.launchCloud ?? startCloudRunner)({ provider, cwd, capsule, computer: deps.computer(),
    title: session.title, model: request.targetModel, effort: request.cloud?.effort, environment: request.cloud?.environment });
  if (!launched.ok) {
    await block(client, request, launched.error);
    return false;
  }
  const store = deps.store();
  store.linkExecution({ taskId: request.taskId, sessionId: launched.reference, provider, computerId: deps.computer(),
    workspace: cwd, repositoryId: capsule.repository, branch: capsule.branch, startedAt: deps.now(),
    external: { runner: provider === "claude" ? "claude_cloud" : "codex_cloud", ...(launched.url ? { url: launched.url } : {}) } });
  const name = provider === "claude" ? "Claude cloud session" : "Codex Cloud task";
  const event = startedEvent(deps, request, `${name} started via ${deps.computer()}. GrantTap cannot follow its progress`
    + (launched.url ? `: ${launched.url}` : `; its id is ${launched.reference}.`));
  store.acceptEvent(event);
  await deps.send(client, event, { ttlMs: DAY, wake: true });
  const snapshot = composeMeshSnapshot(deps, request.projectId);
  if (snapshot) await deps.send(client, snapshot, { ttlMs: 60 * 60_000 });
  return true;
}
