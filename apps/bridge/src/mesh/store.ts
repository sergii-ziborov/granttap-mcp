import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ExecutionSessionLink,
  HandoffReceipt,
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
import { loadStoreState, type StoreState } from "./store-state";
import { preferExecution, isTerminalTaskState, mayOwnTask } from "./convergence";
import { capsuleHash } from "./handoff";
import { mergeBy, resourceOverlap } from "./store-support";
import { closeVanished } from "./execution-sweep";
import { receiptMovesOwnership, taskAfterEvent, taskAfterLocalReading } from "./task-state";
import {
  bindingForRepository,
  upsertBinding as updateBinding,
  workspaceForRepository as boundWorkspace,
} from "./binding-state";
import { mergeSnapshotState } from "./snapshot-merge";

export class MeshStore {
  private state: StoreState;

  constructor(private readonly path: string, private readonly now = Date.now) {
    this.state = loadStoreState(path);
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  upsertProject(input: ProjectValue): void {
    const project = Project.parse(input);
    const previous = this.state.projects.find((item) => item.projectId === project.projectId);
    const next = previous ? { ...project, createdAt: Math.min(previous.createdAt, project.createdAt) } : project;
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
    this.state.projects = this.state.projects.filter((item) => item.projectId !== next.projectId);
    this.state.projects.push(next);
    this.save();
  }

  project(projectId: string): ProjectValue | undefined {
    return this.state.projects.find((item) => item.projectId === projectId);
  }

  upsertBinding(input: BindingValue): void {
    const result = updateBinding(this.state, input);
    if (!result.changed) return;
    this.state.bindings = result.bindings;
    this.save();
  }

  projectIdForRepository(repositoryId: string, endpointId?: string): string | undefined {
    return bindingForRepository(this.state.bindings, repositoryId, endpointId)?.projectId;
  }

  bindingForRepository(repositoryId: string, endpointId?: string): BindingValue | undefined {
    return bindingForRepository(this.state.bindings, repositoryId, endpointId);
  }

  upsertTask(input: TaskValue): void {
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
    const closed = closeVanished(this.state.executions, {
      computerId, liveSessionIds, scannedProviders, endedAt,
    });
    if (closed > 0) this.save();
    return closed;
  }

  taskForExecution(computerId: string, provider: string, sessionId: string): string | undefined {
    return this.state.executions.find((item) =>
      item.computerId === computerId && item.provider === provider && item.sessionId === sessionId)?.taskId;
  }

  linkExecution(input: ExecutionValue): void {
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
    if (previous && JSON.stringify(previous) === JSON.stringify(execution)) return;
    this.state.executions = this.state.executions.filter((item) => !(
      item.computerId === execution.computerId
      && item.provider === execution.provider
      && item.sessionId === execution.sessionId
    ));
    this.state.executions.push(execution);
    this.claimTaskFor(execution);
    this.save();
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
    const receipt = HandoffReceipt.parse(input);
    this.state.receipts = this.state.receipts.filter((item) => item.capsuleHash !== receipt.capsuleHash);
    this.state.receipts.push(receipt);
    this.state.receipts = this.state.receipts.slice(-256);
    this.save();
  }

  claim(input: ResourceClaimValue): void {
    const claim = ResourceClaim.parse(input);
    this.state.claims = this.state.claims.filter((item) => item.claimId !== claim.claimId);
    this.state.claims.push(claim);
    this.save();
  }

  releaseClaim(claimId: string, ownerSessionId?: string): boolean {
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter((claim) =>
      claim.claimId !== claimId || (ownerSessionId != null && claim.ownerSessionId !== ownerSessionId));
    if (this.state.claims.length === before) return false;
    this.save();
    return true;
  }

  releaseClaimsByOwners(ownerSessionIds: ReadonlySet<string>): number {
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter((claim) =>
      !ownerSessionIds.has(claim.ownerSessionId));
    const removed = before - this.state.claims.length;
    if (removed > 0) this.save();
    return removed;
  }

  activeClaims(at = this.now()): ResourceClaimValue[] {
    const active = this.state.claims.filter((claim) => claim.expiresAt > at);
    if (active.length !== this.state.claims.length) {
      this.state.claims = active;
      this.save();
    }
    return [...active];
  }

  conflicts(projectId: string, ownerSessionId: string, resource: string): ResourceClaimValue[] {
    return this.activeClaims().filter((claim) =>
      claim.projectId === projectId
      && claim.ownerSessionId !== ownerSessionId
      && resourceOverlap(claim.resource, resource));
  }

  acceptEvent(input: MeshEventValue): boolean {
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
      this.state.claims = this.state.claims.filter((item) => item.claimId !== event.payload.claimId);
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
    return this.state.events.filter((event) => event.projectId === projectId).slice(-128);
  }

  projectIds(): string[] {
    return this.state.projects.map((project) => project.projectId);
  }

  workspaceForRepository(canonicalRepositoryId: string, computerId?: string): string | undefined {
    return boundWorkspace(this.state, canonicalRepositoryId, computerId);
  }

  task(taskId: string): TaskValue | undefined {
    return this.state.tasks.find((item) => item.taskId === taskId);
  }

  snapshot(projectId: string): SnapshotValue | undefined {
    const project = this.state.projects.find((item) => item.projectId === projectId);
    if (!project) return undefined;
    const tasks = this.state.tasks.filter((task) => task.projectId === projectId).slice(-64);
    const taskIds = new Set(tasks.map((task) => task.taskId));
    return MeshSnapshot.parse({
      type: "mesh.snapshot",
      sessionId: projectId,
      projectId,
      project,
      bindings: this.state.bindings.filter((item) => item.projectId === projectId).slice(0, 64),
      tasks,
      executions: this.state.executions.filter((item) => taskIds.has(item.taskId)).slice(-128),
      claims: this.activeClaims().filter((item) => item.projectId === projectId).slice(-128),
      dependencies: this.state.dependencies.filter((item) => taskIds.has(item.taskId)).slice(-128),
      events: this.eventsForProject(projectId),
      generatedAt: this.now(),
    });
  }

  mergeSnapshot(input: SnapshotValue): void {
    mergeSnapshotState(this.state, input);
    this.save();
  }
}
