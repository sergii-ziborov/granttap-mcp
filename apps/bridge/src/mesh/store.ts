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
} from "../../../../packages/protocol/schema";
import type { IntegrationEdge } from "./integration-map";
import { integrationPeerKey } from "./other-side";
import { readStoreState, MAX_STORE_PEERS, type StoreState } from "./store-state";
import {
  applyStoreDelta,
  deltaIsEmpty,
  setAsideStore,
  storeDelta,
  storeFingerprint,
  StoreLockError,
  withStoreLock,
  writeStoreState,
} from "./store-sync";
import { preferExecution, isTerminalTaskState, mayOwnTask } from "./convergence";
import { capsuleHash } from "./handoff";
import { mergeBy, scopedOverlapKind, type ResourceScope } from "./store-support";
import { closeVanished } from "./execution-sweep";
import { receiptMovesOwnership, taskAfterEvent, taskAfterLocalReading } from "./task-state";
import {
  bindingForEndpoint,
  bindingForRepository,
  upsertBinding as updateBinding,
  workspaceForRepository as boundWorkspace,
} from "./binding-state";
import { mergeSnapshotState } from "./snapshot-merge";
import { selectSnapshotTasks } from "./snapshot-window";
import { projectSharedSkills } from "../capabilities/skills";

export class MeshStore {
  private state: StoreState;
  /** The state as the disk last had it, so a save can tell what this process changed. */
  private baseline: StoreState;
  /** The file this process last read or wrote; another file under the path is news. */
  private synced: string | undefined;

  /** How long a write waits for the store's lock before it is kept for later. */
  private readonly lockWaitMs: number | undefined;

  constructor(
    private readonly path: string,
    private readonly now = Date.now,
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
  private sync(): void {
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
  private save(): boolean {
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
  private syncAndWriteUnderLock(): void {
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

  private replaceTask(task: TaskValue): void {
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
  private closeElsewhere(execution: ExecutionValue): boolean {
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

  private claimTaskFor(execution: ExecutionValue): void {
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

  recordReceipt(input: ReceiptValue): void {
    this.sync();
    const receipt = HandoffReceipt.parse(input);
    this.state.receipts = this.state.receipts.filter((item) => item.capsuleHash !== receipt.capsuleHash);
    this.state.receipts.push(receipt);
    this.state.receipts = this.state.receipts.slice(-256);
    this.save();
  }

  claim(input: ResourceClaimValue): void {
    this.sync();
    const claim = ResourceClaim.parse(input);
    if (this.isReleased(claim.claimId)) return;
    this.state.claims = this.state.claims.filter((item) => item.claimId !== claim.claimId);
    this.state.claims.push(claim);
    this.save();
  }

  /**
   * Whether a claim was released and is still remembered as such: a copy of
   * it arriving late, from a computer that was away or a phone that carried
   * it round, is not the claim coming back.
   */
  private isReleased(claimId: string, at = this.now()): boolean {
    return this.state.releasedClaims.some((item) => item.claimId === claimId && item.expiresAt > at);
  }

  /** Write a release down, for as long as the claim itself would have lasted. */
  private remember(released: ResourceClaimValue[]): void {
    const at = this.now();
    const kept = this.state.releasedClaims.filter((item) =>
      item.expiresAt > at && !released.some((claim) => claim.claimId === item.claimId));
    this.state.releasedClaims = [
      ...kept,
      ...released.map((claim) => ({ claimId: claim.claimId, releasedAt: at, expiresAt: Math.max(claim.expiresAt, at + 1) })),
    ].slice(-256);
  }

  releaseClaim(claimId: string, ownerSessionId?: string): boolean {
    this.sync();
    const released = this.state.claims.filter((claim) =>
      claim.claimId === claimId && (ownerSessionId == null || claim.ownerSessionId === ownerSessionId));
    if (released.length === 0) return false;
    this.state.claims = this.state.claims.filter((claim) => !released.includes(claim));
    this.remember(released);
    this.save();
    return true;
  }

  releaseClaimsByOwners(ownerSessionIds: ReadonlySet<string>): number {
    this.sync();
    const released = this.state.claims.filter((claim) => ownerSessionIds.has(claim.ownerSessionId));
    if (released.length === 0) return 0;
    this.state.claims = this.state.claims.filter((claim) => !released.includes(claim));
    this.remember(released);
    this.save();
    return released.length;
  }

  activeClaims(at = this.now()): ResourceClaimValue[] {
    this.sync();
    const active = this.liveClaims(at);
    const tombstones = this.state.releasedClaims.filter((item) => item.expiresAt > at);
    if (active.length !== this.state.claims.length || tombstones.length !== this.state.releasedClaims.length) {
      this.state.claims = active;
      this.state.releasedClaims = tombstones;
      this.save();
    }
    return [...active];
  }

  /** The claims that hold at `at`, read without writing anything. */
  private liveClaims(at: number): ResourceClaimValue[] {
    return this.state.claims.filter((claim) => claim.expiresAt > at);
  }

  /**
   * A claim event from an agent, checked and recorded as one step under the
   * store's lock: the conflict it is checked against is the state it is
   * written into, so two agents claiming one file at once cannot both be
   * told the file was free. Not applied at all when the lock is not taken
   * in time, and the caller says so.
   */
  acceptClaimEvent(input: MeshEventValue): { applied: false } | { applied: true; accepted: boolean; conflict?: ResourceClaimValue } {
    const parsed = MeshEvent.safeParse(input);
    if (!parsed.success || parsed.data.eventType !== "RESOURCE_CLAIM" || !parsed.data.payload.claim) {
      return { applied: true, accepted: false };
    }
    const event = parsed.data;
    const claim = event.payload.claim!;
    const result = this.transact((): { accepted: boolean; conflict?: ResourceClaimValue } => {
      const conflict = this.liveClaims(this.now()).find((item) =>
        item.projectId === event.projectId
        && item.ownerSessionId !== event.sourceSessionId
        && scopedOverlapKind(item, claim) === "file");
      if (conflict) return { accepted: false, conflict };
      if (this.state.events.some((item) => item.eventId === event.eventId)) return { accepted: false };
      this.state.events.push(event);
      this.state.events = this.state.events.slice(-512);
      this.applyEvent(event);
      return { accepted: true };
    });
    return result.applied ? { applied: true, ...result.value } : { applied: false };
  }

  conflicts(projectId: string, ownerSessionId: string, resource: string,
    scope: ResourceScope = {}, blockUnscopedLegacy = false): ResourceClaimValue[] {
    this.sync();
    return this.activeClaims().filter((claim) =>
      claim.projectId === projectId
      && claim.ownerSessionId !== ownerSessionId
      && (scopedOverlapKind(claim, { resource, ...scope }) === "file"
        || (blockUnscopedLegacy && (!claim.repositoryId || !scope.repositoryId)
          && scopedOverlapKind(claim, { resource, ...scope }) === "logical_file")));
  }

  /**
   * Claims by someone else in the same module, short of the same file.
   *
   * Not a conflict — two agents can work one module without colliding. It is
   * the warning that comes before the conflict, reported rather than enforced.
   */
  moduleOverlaps(projectId: string, ownerSessionId: string, resource: string, scope: ResourceScope = {}): ResourceClaimValue[] {
    this.sync();
    return this.activeClaims().filter((claim) =>
      claim.projectId === projectId
      && claim.ownerSessionId !== ownerSessionId
      && ["module", "logical_file"].includes(scopedOverlapKind(claim, { resource, ...scope }) ?? ""));
  }

  /**
   * Record what an agent was seen editing, as an intent claim.
   *
   * Agents rarely announce a claim; they just write. The transcript shows the
   * write, so the claim is derived from it — marked `intent`, because nobody
   * stated it, and extended while the writing continues. No event is
   * appended: an observation is not something the agent said.
   */
  observeClaim(input: ResourceClaimValue): boolean {
    this.sync();
    const claim = ResourceClaim.parse(input);
    if (this.isReleased(claim.claimId)) return false;
    const previous = this.state.claims.find((item) => item.claimId === claim.claimId);
    if (previous && previous.ownerSessionId === claim.ownerSessionId
      && previous.expiresAt >= claim.expiresAt) return false;
    this.state.claims = mergeBy(this.state.claims, [claim], (item) => item.claimId);
    this.save();
    return true;
  }

  acceptEvent(input: MeshEventValue): boolean {
    this.sync();
    const parsed = MeshEvent.safeParse(input);
    if (!parsed.success) return false;
    const event = parsed.data;
    if (event.expiresAt != null && event.expiresAt <= this.now()) return false;
    if (event.eventType === "HANDOFF_ACCEPTED" && !this.validReceipt(event)) return false;
    if (this.state.events.some((item) => item.eventId === event.eventId)) return false;
    this.state.events.push(event);
    this.state.events = this.state.events.slice(-512);
    this.applyEvent(event);
    this.save();
    return true;
  }

  private validReceipt(event: MeshEventValue): boolean {
    const receipt = event.payload.receipt;
    if (!receipt || receipt.taskId !== event.taskId) return false;
    const request = [...this.state.events].reverse().find((item) =>
      item.eventType === "HANDOFF_REQUEST"
      && item.taskId === event.taskId
      && item.sourceSessionId === receipt.sourceSessionId
      && item.payload.capsule != null);
    if (request?.payload.capsule == null) return false;
    const digest = capsuleHash(request.payload.capsule);
    if (digest === receipt.capsuleHash) return true;
    // A receipt written before this Task was rejoined names the capsule by
    // the hash it had then; the move is on record, so the receipt still holds.
    return this.state.migrations.some((item) =>
      item.taskIdTo === event.taskId
      && item.capsuleHashTo === digest
      && item.capsuleHashFrom === receipt.capsuleHash);
  }

  private applyEvent(event: MeshEventValue): void {
    if (event.eventType === "RESOURCE_CLAIM" && event.payload.claim && !this.isReleased(event.payload.claim.claimId)) {
      this.state.claims = mergeBy(this.state.claims, [event.payload.claim], (item) => item.claimId);
    }
    if (event.eventType === "RESOURCE_RELEASE" && event.payload.claimId) {
      // Only the owner releases its claim, and only from inside the claim's
      // own Task and Project: a claim id is not a secret, and a chat that
      // learned one must not be able to clear someone else's hold on a file.
      const released = this.state.claims.filter((item) =>
        item.claimId === event.payload.claimId
        && item.ownerSessionId === event.sourceSessionId
        && item.projectId === event.projectId
        && item.taskId === event.taskId);
      if (released.length > 0) {
        this.state.claims = this.state.claims.filter((item) => !released.includes(item));
        this.remember(released);
      }
    }
    if (event.eventType === "DEPENDENCY" && event.payload.dependsOnTaskId) {
      this.state.dependencies = mergeBy(this.state.dependencies, [{
        taskId: event.taskId,
        dependsOnTaskId: event.payload.dependsOnTaskId,
        summary: event.payload.summary,
        createdAt: event.createdAt,
      }], (item) => `${item.taskId}\0${item.dependsOnTaskId}`);
    }
    const task = this.state.tasks.find((item) => item.taskId === event.taskId);
    if (!task) return;
    const receipt = event.payload.receipt;
    if (event.eventType === "HANDOFF_ACCEPTED" && receipt) {
      if (!receiptMovesOwnership(task, receipt, this.state.receipts)) return;
      const source = this.state.executions.find((item) =>
        item.taskId === event.taskId && item.sessionId === receipt.sourceSessionId);
      if (source) source.endedAt = receipt.acceptedAt;
      this.state.receipts = [
        ...this.state.receipts.filter((item) => item.capsuleHash !== receipt.capsuleHash),
        receipt,
      ].slice(-256);
    }
    const next = taskAfterEvent(task, event);
    if (next) this.replaceTask(next);
  }

  eventsForProject(projectId: string): MeshEventValue[] {
    this.sync();
    return this.state.events.filter((event) => event.projectId === projectId).slice(-128);
  }

  projectIds(): string[] {
    this.sync();
    return this.state.projects.map((project) => project.projectId);
  }

  workspaceForRepository(canonicalRepositoryId: string, computerId?: string): string | undefined {
    this.sync();
    return boundWorkspace(this.state, canonicalRepositoryId, computerId);
  }

  task(taskId: string): TaskValue | undefined {
    this.sync();
    return this.state.tasks.find((item) => item.taskId === taskId);
  }

  /**
   * What one bound repository states about its neighbours. The whole statement
   * for that repository is replaced, so an edge removed from the map is removed
   * here; nothing is written when the statement has not changed.
   */
  recordIntegrationPeers(projectId: string, repositoryId: string, edges: IntegrationEdge[]): void {
    this.sync();
    if (!this.state.projects.some((item) => item.projectId === projectId)) return;
    const stated = edges.slice(0, 64).map((edge) => IntegrationPeer.parse({
      projectId, repositoryId, peer: edge.peer, via: edge.via, relation: edge.relation,
      through: edge.through, updatedAt: this.now(),
    }));
    const current = this.state.peers.filter((item) =>
      item.projectId === projectId && item.repositoryId === repositoryId);
    const same = current.length === stated.length
      && current.every((item, index) => integrationPeerKey(item) === integrationPeerKey(stated[index]!));
    if (same) return;
    const kept = this.state.peers.filter((item) =>
      !(item.projectId === projectId && item.repositoryId === repositoryId));
    this.state.peers = [...kept, ...stated].slice(-MAX_STORE_PEERS);
    this.save();
  }

  snapshot(projectId: string): SnapshotValue | undefined {
    this.sync();
    const project = this.state.projects.find((item) => item.projectId === projectId);
    if (!project) return undefined;
    const allTasks = this.state.tasks.filter((task) => task.projectId === projectId);
    const { tasks, incomplete } = selectSnapshotTasks(allTasks);
    const taskIds = new Set(tasks.map((task) => task.taskId));
    const peers = this.state.peers.filter((item) => item.projectId === projectId).slice(0, 64);
    const bindings = this.state.bindings.filter((item) => item.projectId === projectId).slice(0, 64);
    const skills = projectSharedSkills([
      project.repositoryRoot,
      ...bindings.map((binding) => binding.localPathHint),
      ...this.state.executions.filter((item) => taskIds.has(item.taskId)).map((item) => item.workspace),
    ]);
    return MeshSnapshot.parse({
      type: "mesh.snapshot",
      sessionId: projectId,
      projectId,
      project,
      bindings,
      // Absent rather than empty: a repository without a map publishes the
      // snapshot it always did.
      peers: peers.length > 0 ? peers : undefined,
      skills: skills.length > 0 ? skills : undefined,
      incomplete: incomplete || undefined,
      tasks,
      executions: this.state.executions.filter((item) => taskIds.has(item.taskId)).slice(-128),
      claims: this.activeClaims().filter((item) => item.projectId === projectId && taskIds.has(item.taskId)).slice(-128),
      dependencies: this.state.dependencies.filter((item) => taskIds.has(item.taskId)).slice(-128),
      events: this.eventsForProject(projectId).filter((event) => taskIds.has(event.taskId)),
      generatedAt: this.now(),
    });
  }

  mergeSnapshot(input: SnapshotValue): void {
    this.sync();
    mergeSnapshotState(this.state, input);
    // A released claim does not come back with a snapshot that still has it.
    const at = this.now();
    this.state.claims = this.state.claims.filter((claim) => !this.isReleased(claim.claimId, at));
    this.save();
  }
}
