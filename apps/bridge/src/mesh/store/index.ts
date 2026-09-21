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
import { MAX_STORE_PEERS, type StoreState } from "./state";
import { preferExecution, isTerminalTaskState, mayOwnTask } from "../admin/convergence";
import { capsuleHash } from "../handoff";
import { mergeBy, scopedOverlapKind, type ResourceScope } from "./support";
import { receiptMovesOwnership, taskAfterEvent, taskAfterLocalReading } from "../tasks/state";
import { workspaceForRepository as boundWorkspace } from "../catalog/binding-state";
import { mergeSnapshotState } from "../snapshot/merge";
import { selectSnapshotTasks } from "../snapshot/window";
import { projectSharedSkills } from "../../capabilities/skills";
import { loadExecutionPolicy } from "../runtime/execution-policy";
import { loadEnvironment, redactEnvironment } from "../context/env";
import { loadRestrictions } from "../restrictions";
import { MeshStoreBase } from "./base";
import {
  projectCapabilityRequests,
} from "../catalog/project/requests";

export class MeshStore extends MeshStoreBase {
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

  snapshot(projectId: string, localEndpointId?: string): SnapshotValue | undefined {
    this.sync();
    const project = this.state.projects.find((item) => item.projectId === projectId);
    if (!project) return undefined;
    const allTasks = this.state.tasks.filter((task) => task.projectId === projectId);
    const { tasks, incomplete } = selectSnapshotTasks(allTasks);
    const taskIds = new Set(tasks.map((task) => task.taskId));
    const peers = this.state.peers.filter((item) => item.projectId === projectId).slice(0, 64);
    const bindings = this.state.bindings.filter((item) => item.projectId === projectId).slice(0, 64);
    // Paths from another endpoint are evidence of a binding, never local
    // directories to scan or a local capability installation.
    const verifiedRoot = localEndpointId == null || bindings.some((binding) =>
      binding.endpointId === localEndpointId && binding.localPathHint === project.repositoryRoot)
      ? project.repositoryRoot : undefined;
    const skills = projectSharedSkills([
      verifiedRoot,
      ...bindings.filter((binding) => binding.endpointId === localEndpointId)
        .map((binding) => binding.localPathHint),
      ...this.state.executions.filter((item) =>
        taskIds.has(item.taskId) && item.computerId === localEndpointId)
        .map((item) => item.workspace),
    ], localEndpointId);
    const execution = loadExecutionPolicy(projectId);
    const restrictions = loadRestrictions(projectId);
    const environment = redactEnvironment(loadEnvironment(projectId));
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
      capabilityRequests: projectCapabilityRequests(projectId),
      incomplete: incomplete || undefined,
      ...(execution ? { execution: {
        mode: execution.mode,
        targetEndpointId: execution.targetEndpointId,
        defaultProvider: execution.defaultProvider,
        defaultModel: execution.defaultModel,
        revision: execution.revision,
        hostGrantId: execution.hostGrantId,
        hostGrantStatus: execution.hostGrantStatus,
        offlineBehavior: execution.offlineBehavior,
      } } : {}),
      ...(restrictions ? { restrictions } : {}),
      ...(environment ? { environment } : {}),
      tasks,
      executions: this.state.executions.filter((item) => taskIds.has(item.taskId)).slice(-128),
      claims: this.activeClaims().filter((item) => item.projectId === projectId && taskIds.has(item.taskId)).slice(-128),
      dependencies: this.state.dependencies.filter((item) => taskIds.has(item.taskId)).slice(-128),
      events: this.eventsForProject(projectId).filter((event) => taskIds.has(event.taskId)),
      knowledge: this.state.knowledge.filter((item) => item.projectId === projectId)
        .slice(-16).reverse(),
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

  cacheKnowledge(projectId: string, records: NonNullable<SnapshotValue["knowledge"]>): void {
    this.sync();
    const incoming = records.filter((item) => item.projectId === projectId
      && item.visibility === "project");
    if (incoming.length === 0) return;
    const known = new Set(this.state.knowledge.map((item) => `${item.projectId}\0${item.recordId}`));
    const fresh = incoming.filter((item) => !known.has(`${item.projectId}\0${item.recordId}`));
    if (fresh.length === 0) return;
    this.state.knowledge = [...this.state.knowledge, ...fresh].slice(-256);
    this.save();
  }
}
