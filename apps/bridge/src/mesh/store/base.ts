import {
  ExecutionSessionLink,
  HandoffReceipt,
  IntegrationPeer,
  MeshEvent,
  MeshSnapshot,
  MeshTask,
  Project,
  ResourceClaim,
  type ExecutionSessionLink as ExecutionValue,
  type HandoffReceipt as ReceiptValue,
  type MeshEvent as MeshEventValue,
  type MeshSnapshot as SnapshotValue,
  type MeshTask as TaskValue,
  type Project as ProjectValue,
  type ProjectBindingSummary as BindingValue,
  type ResourceClaim as ResourceClaimValue,
} from "../../../../../packages/protocol/schema";
import type { IntegrationEdge } from "../observed/integration-map";
import { integrationPeerKey } from "../handoff/other-side";
import { readStoreState, MAX_STORE_PEERS, type StoreState } from "./state";
import {
  applyStoreDelta,
  deltaIsEmpty,
  setAsideStore,
  storeDelta,
  storeFingerprint,
  StoreLockError,
  withStoreLock,
  writeStoreState,
} from "./sync";
import { preferExecution, isTerminalTaskState, mayOwnTask } from "../admin/convergence";
import { capsuleHash } from "../handoff";
import { mergeBy, scopedOverlapKind, type ResourceScope } from "./support";
import { closeVanished } from "../runtime/execution-sweep";
import { receiptMovesOwnership, taskAfterEvent, taskAfterLocalReading } from "../tasks/state";
import {
  bindingForEndpoint,
  bindingForRepository,
  upsertBinding as updateBinding,
  workspaceForRepository as boundWorkspace,
} from "../catalog/binding-state";
import { mergeSnapshotState } from "../snapshot/merge";
import { selectSnapshotTasks } from "../snapshot/window";
import { projectSharedSkills } from "../../capabilities/skills";
import { loadExecutionPolicy } from "../runtime/execution-policy";
import { loadEnvironment, redactEnvironment } from "../context/env";
import { loadRestrictions } from "../restrictions";

export class MeshStoreBase {
  protected state: StoreState;
  /** The state as the disk last had it, so a save can tell what this process changed. */
  protected baseline: StoreState;
  /** The file this process last read or wrote; another file under the path is news. */
  protected synced: string | undefined;

  /** How long a write waits for the store's lock before it is kept for later. */
  protected readonly lockWaitMs: number | undefined;

  constructor(
    protected readonly path: string,
    protected readonly now = Date.now,
    options: { lockWaitMs?: number } = {},
  ) {
    this.lockWaitMs = options.lockWaitMs;
    const loaded = readStoreState(path);
    this.state = loaded.state;
    this.baseline = structuredClone(loaded.state);
    if (loaded.status === "corrupt" || loaded.status === "too_large") {
      // Kept beside the store for a person to look at, not written over.
      setAsideStore(path, this.now());
    }
    this.synced = storeFingerprint(path);
  }

  /**
   * Take in what another process wrote since this one last looked. Called on
   * entry to every public method, never in the middle of one, so a change
   * made and not yet saved is never thrown away: what this process changed
   * and could not yet write is laid over what arrived.
   */
  protected sync(): void {
    const current = storeFingerprint(this.path);
    if (current === this.synced) return;
    const loaded = readStoreState(this.path);
    if (loaded.status === "ok" || loaded.status === "missing") {
      const pending = storeDelta(this.baseline, this.state);
      this.state = deltaIsEmpty(pending) ? loaded.state : applyStoreDelta(loaded.state, pending);
      this.baseline = structuredClone(loaded.state);
      this.synced = current;
      return;
    }
    if (loaded.status !== "not_file") setAsideStore(this.path, this.now());
    this.synced = storeFingerprint(this.path);
  }

  /**
   * Write what changed here over what is on disk now, under the store's lock.
   * A lock that cannot be taken in time is not a reason to write anyway: the
   * change stays in memory, ahead of the baseline, and the next save carries it.
   */
  protected save(): boolean {
    try {
      withStoreLock(this.path, () => this.syncAndWriteUnderLock(), { waitMs: this.lockWaitMs });
      return true;
    } catch (error) {
      if (!(error instanceof StoreLockError)) throw error;
      this.unsaved = true;
      return false;
    }
  }

  /**
   * Lay what this process changed over what is on disk, under the lock the
   * caller already holds, and write the result.
   */
  protected syncAndWriteUnderLock(): void {
    const delta = storeDelta(this.baseline, this.state);
    let merged = this.state;
    if (storeFingerprint(this.path) !== this.synced) {
      const disk = readStoreState(this.path);
      if (disk.status === "ok") {
        merged = deltaIsEmpty(delta) ? disk.state : applyStoreDelta(disk.state, delta);
      } else if (disk.status === "corrupt" || disk.status === "too_large") {
        setAsideStore(this.path, this.now());
      }
    }
    writeStoreState(this.path, merged);
    this.state = merged;
    this.baseline = structuredClone(merged);
    this.synced = storeFingerprint(this.path);
  }

  /**
   * Check and change as one: what `run` reads is what it changes, and the
   * change is on disk before anyone is told. Under the lock the file is
   * read again first, so another process's write between this process's
   * last look and now is seen. When the lock cannot be taken in time nothing
   * is changed, and the caller says so instead of answering as if it were.
   */
  transact<T>(run: () => T): { applied: true; value: T } | { applied: false } {
    try {
      return withStoreLock(this.path, () => {
        // Take in the disk as it is now, with what this process still owes laid over.
        if (storeFingerprint(this.path) !== this.synced) {
          const loaded = readStoreState(this.path);
          if (loaded.status === "ok" || loaded.status === "missing") {
            const pending = storeDelta(this.baseline, this.state);
            this.state = deltaIsEmpty(pending) ? loaded.state : applyStoreDelta(loaded.state, pending);
            this.baseline = structuredClone(loaded.state);
            this.synced = storeFingerprint(this.path);
          }
        }
        const value = run();
        this.syncAndWriteUnderLock();
        return { applied: true as const, value };
      }, { waitMs: this.lockWaitMs });
    } catch (error) {
      if (!(error instanceof StoreLockError)) throw error;
      return { applied: false };
    }
  }

  /** Whether the last write was held back by the lock; cleared by the next successful write. */
  private unsaved = false;

  /** Whether a change made here is still waiting for the lock to be written. */
  get hasUnsavedChanges(): boolean {
    return this.unsaved && !deltaIsEmpty(storeDelta(this.baseline, this.state));
  }

  /** Try again to write what the lock held back. */
  flush(): boolean {
    this.sync();
    if (deltaIsEmpty(storeDelta(this.baseline, this.state))) {
      this.unsaved = false;
      return true;
    }
    const written = this.save();
    if (written) this.unsaved = false;
    return written;
  }

  upsertProject(input: ProjectValue): void {
    this.sync();
    const project = Project.parse(input);
    const previous = this.state.projects.find((item) => item.projectId === project.projectId);
    const next = previous ? { ...project, createdAt: Math.min(previous.createdAt, project.createdAt) } : project;
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.state.projects = this.state.projects.filter((item) => item.projectId !== next.projectId);
    this.state.projects.push(next);
    this.save();
  }

  project(projectId: string): ProjectValue | undefined {
    this.sync();
    return this.state.projects.find((item) => item.projectId === projectId);
  }

  upsertBinding(input: BindingValue): void {
    this.sync();
    const result = updateBinding(this.state, input);
    if (!result.changed) return;
    this.state.bindings = result.bindings;
    this.save();
  }

  projectIdForRepository(repositoryId: string, endpointId?: string): string | undefined {
    this.sync();
    return bindingForRepository(this.state.bindings, repositoryId, endpointId)?.projectId;
  }

  bindingForRepository(repositoryId: string, endpointId?: string): BindingValue | undefined {
    this.sync();
    return bindingForRepository(this.state.bindings, repositoryId, endpointId);
  }

  /** This endpoint's own binding, never another computer's. */
  bindingForEndpoint(repositoryId: string, endpointId: string): BindingValue | undefined {
    this.sync();
    return bindingForEndpoint(this.state.bindings, repositoryId, endpointId);
  }

  upsertTask(input: TaskValue): void {
    this.sync();
    const task = MeshTask.parse(input);
    const previous = this.state.tasks.find((item) => item.taskId === task.taskId);
    const next = previous
      ? taskAfterLocalReading(previous, task, this.state.executions)
      : { ...task, revision: task.revision ?? 0 };
    if (!next) return;
    this.replaceTask(next);
    this.save();
  }

  protected replaceTask(task: TaskValue): void {
    this.state.tasks = this.state.tasks.filter((item) => item.taskId !== task.taskId);
    this.state.tasks.push(task);
  }

  /** Close executions this computer no longer runs. See `execution-sweep`. */
  closeVanishedExecutions(
    computerId: string,
    liveSessionIds: ReadonlySet<string>,
    scannedProviders: ReadonlySet<string>,
    endedAt = this.now(),
  ): number {
    this.sync();
    const closed = closeVanished(this.state.executions, {
      computerId, liveSessionIds, scannedProviders, endedAt,
    });
    if (closed > 0) this.save();
    return closed;
  }

  /**
   * The Task this chat already belongs to, whichever computer reports it.
   *
   * A chat is identified by its provider session id, which is unique across
   * machines — and the same chat is genuinely visible from more than one, both
   * because an agent can read another machine's conversations and because a
   * machine's own name is not stable: macOS renames a Mac with the network it
   * joins. Keying the lookup by computer therefore minted a second Task for one
   * chat every time either changed, and the list showed the chat twice.
   *
   * Executions stay per computer, so two machines working one chat still read
   * as two executions of a single Task, which is what they are.
   */
  taskForExecution(computerId: string, provider: string, sessionId: string): string | undefined {
    this.sync();
    const own = this.state.executions.find((item) =>
      item.computerId === computerId && item.provider === provider && item.sessionId === sessionId);
    if (own) return own.taskId;
    return this.state.executions.find((item) =>
      item.provider === provider && item.sessionId === sessionId)?.taskId;
  }

  linkExecution(input: ExecutionValue): void {
    this.sync();
    const parsed = ExecutionSessionLink.parse({
      ...input, updatedAt: input.updatedAt ?? this.now(),
    });
    const previous = this.state.executions.find((item) =>
      item.computerId === parsed.computerId
      && item.provider === parsed.provider
      && item.sessionId === parsed.sessionId);
    // A closed execution stays closed: the Task moved on, even when the native
    // session it left behind is still running and still reports itself.
    const execution = previous ? preferExecution(previous, parsed) : parsed;
    const closedElsewhere = this.closeElsewhere(execution);
    if (previous && JSON.stringify(previous) === JSON.stringify(execution)) {
      if (closedElsewhere) this.save();
      return;
    }
    this.state.executions = this.state.executions.filter((item) => !(
      item.computerId === execution.computerId
      && item.provider === execution.provider
      && item.sessionId === execution.sessionId
    ));
    this.state.executions.push(execution);
    this.claimTaskFor(execution);
    this.save();
  }

  /**
   * Retire what this computer wrote under a former name: an execution still
   * open there is over, a binding still offered there is unavailable. Nothing
   * is deleted, so a phone that still holds the old rows learns the same.
   */
  retireComputerNames(computerId: string, formerNames: string[]): void {
    this.sync();
    const former = new Set(formerNames.filter((name) => name && name !== computerId));
    if (former.size === 0) return;
    const now = this.now();
    let changed = false;
    for (const execution of this.state.executions) {
      if (execution.endedAt == null && former.has(execution.computerId)) {
        execution.endedAt = now;
        execution.updatedAt = now;
        changed = true;
      }
    }
    this.state.bindings = this.state.bindings.map((binding) => {
      if (!binding.available || !former.has(binding.endpointId)) return binding;
      changed = true;
      return { ...binding, available: false };
    });
    if (changed) this.save();
  }

  /**
   * One chat runs on one computer. The same Mac renamed by the network it
   * joined ("Mac.lan", "Serhiis-MacBook-Pro.local") kept an open execution
   * under each name, so its Task counted two computers and the phone drew two
   * cards for one conversation. The execution seen now is the one that lives;
   * the same chat's execution under any other computer name is over.
   */
  protected closeElsewhere(execution: ExecutionValue): boolean {
    if (execution.endedAt != null) return false;
    const endedAt = this.now();
    let closed = false;
    for (const other of this.state.executions) {
      if (other.endedAt != null || other.provider !== execution.provider
        || other.sessionId !== execution.sessionId || other.computerId === execution.computerId) continue;
      other.endedAt = endedAt;
      other.updatedAt = endedAt;
      closed = true;
    }
    return closed;
  }

  protected claimTaskFor(execution: ExecutionValue): void {
    const task = this.state.tasks.find((item) => item.taskId === execution.taskId);
    if (!task || execution.endedAt != null) return;
    if (!mayOwnTask(task, execution.sessionId, this.state.executions)) return;
    // A cataloged execution can be idle and still available to continue. Only
    // a handoff proves newly started work; promoting every planned Task made
    // quiet native sessions appear as another actively working agent.
    const state = !isTerminalTaskState(task.state) && task.state === "handoff"
      ? "working"
      : task.state;
    this.replaceTask({
      ...task,
      ownerSessionId: execution.sessionId,
      state,
      updatedAt: Math.max(task.updatedAt, execution.startedAt),
      revision: (task.revision ?? 0) + 1,
    });
  }
}
