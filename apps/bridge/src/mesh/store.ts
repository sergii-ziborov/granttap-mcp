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
  withStoreLock,
  writeStoreState,
} from "./store-sync";
import { preferExecution, isTerminalTaskState, mayOwnTask } from "./convergence";
import { capsuleHash } from "./handoff";
import { mergeBy, overlapKind, resourceOverlap } from "./store-support";
import { closeVanished } from "./execution-sweep";
import { receiptMovesOwnership, taskAfterEvent, taskAfterLocalReading } from "./task-state";
import {
  bindingForEndpoint,
  bindingForRepository,
  upsertBinding as updateBinding,
  workspaceForRepository as boundWorkspace,
} from "./binding-state";
import { mergeSnapshotState } from "./snapshot-merge";

export class MeshStore {
  private state: StoreState;
  /** The state as the disk last had it, so a save can tell what this process changed. */
  private baseline: StoreState;
  /** The file this process last read or wrote; another file under the path is news. */
  private synced: string | undefined;

  constructor(private readonly path: string, private readonly now = Date.now) {
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
   * made and not yet saved is never thrown away.
   */
  private sync(): void {
    const current = storeFingerprint(this.path);
    if (current === this.synced) return;
    const loaded = readStoreState(this.path);
    if (loaded.status === "ok" || loaded.status === "missing") {
      this.state = loaded.state;
      this.baseline = structuredClone(loaded.state);
      this.synced = current;
      return;
    }
    if (loaded.status !== "not_file") setAsideStore(this.path, this.now());
    this.synced = storeFingerprint(this.path);
  }

  /** Write what changed here over what is on disk now, under the store's lock. */
  private save(): void {
    withStoreLock(this.path, () => {
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
    });
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
    this.state.claims = this.state.claims.filter((item) => item.claimId !== claim.claimId);
    this.state.claims.push(claim);
    this.save();
  }

  releaseClaim(claimId: string, ownerSessionId?: string): boolean {
    this.sync();
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter((claim) =>
      claim.claimId !== claimId || (ownerSessionId != null && claim.ownerSessionId !== ownerSessionId));
    if (this.state.claims.length === before) return false;
    this.save();
    return true;
  }

  releaseClaimsByOwners(ownerSessionIds: ReadonlySet<string>): number {
    this.sync();
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter((claim) =>
      !ownerSessionIds.has(claim.ownerSessionId));
    const removed = before - this.state.claims.length;
    if (removed > 0) this.save();
    return removed;
  }

  activeClaims(at = this.now()): ResourceClaimValue[] {
    this.sync();
    const active = this.state.claims.filter((claim) => claim.expiresAt > at);
    if (active.length !== this.state.claims.length) {
      this.state.claims = active;
      this.save();
    }
    return [...active];
  }

  conflicts(projectId: string, ownerSessionId: string, resource: string): ResourceClaimValue[] {
    this.sync();
    return this.activeClaims().filter((claim) =>
      claim.projectId === projectId
      && claim.ownerSessionId !== ownerSessionId
      && resourceOverlap(claim.resource, resource));
  }

  /**
   * Claims by someone else in the same module, short of the same file.
   *
   * Not a conflict — two agents can work one module without colliding. It is
   * the warning that comes before the conflict, reported rather than enforced.
   */
  moduleOverlaps(projectId: string, ownerSessionId: string, resource: string): ResourceClaimValue[] {
    this.sync();
    return this.activeClaims().filter((claim) =>
      claim.projectId === projectId
      && claim.ownerSessionId !== ownerSessionId
      && overlapKind(claim.resource, resource) === "module");
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
    return request?.payload.capsule != null
      && capsuleHash(request.payload.capsule) === receipt.capsuleHash;
  }

  private applyEvent(event: MeshEventValue): void {
    if (event.eventType === "RESOURCE_CLAIM" && event.payload.claim) {
      this.state.claims = mergeBy(this.state.claims, [event.payload.claim], (item) => item.claimId);
    }
    if (event.eventType === "RESOURCE_RELEASE" && event.payload.claimId) {
      // Only the owner releases its claim, and only from inside the claim's
      // own Task and Project: a claim id is not a secret, and a chat that
      // learned one must not be able to clear someone else's hold on a file.
      this.state.claims = this.state.claims.filter((item) =>
        item.claimId !== event.payload.claimId
        || item.ownerSessionId !== event.sourceSessionId
        || item.projectId !== event.projectId
        || item.taskId !== event.taskId);
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
    const tasks = this.state.tasks.filter((task) => task.projectId === projectId).slice(-64);
    const taskIds = new Set(tasks.map((task) => task.taskId));
    const peers = this.state.peers.filter((item) => item.projectId === projectId).slice(0, 64);
    return MeshSnapshot.parse({
      type: "mesh.snapshot",
      sessionId: projectId,
      projectId,
      project,
      bindings: this.state.bindings.filter((item) => item.projectId === projectId).slice(0, 64),
      // Absent rather than empty: a repository without a map publishes the
      // snapshot it always did.
      peers: peers.length > 0 ? peers : undefined,
      tasks,
      executions: this.state.executions.filter((item) => taskIds.has(item.taskId)).slice(-128),
      claims: this.activeClaims().filter((item) => item.projectId === projectId).slice(-128),
      dependencies: this.state.dependencies.filter((item) => taskIds.has(item.taskId)).slice(-128),
      events: this.eventsForProject(projectId),
      generatedAt: this.now(),
    });
  }

  mergeSnapshot(input: SnapshotValue): void {
    this.sync();
    mergeSnapshotState(this.state, input);
    this.save();
  }
}
