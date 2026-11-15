/**
 * The person's changes to which repositories a Project holds on this
 * computer. Each is checked and written as one step under the store's lock,
 * so the binding it is checked against is the binding it changes.
 */
import type { ProjectBindingSummary as BindingValue } from "../../../../../../packages/protocol/schema";
import { upsertBinding } from "../../catalog/binding-state";
import { MeshPreparedStore } from "../receipts/prepared-availability";
import { bindingRemoved, MAX_REMOVED_BINDINGS, type RemovedBinding } from "../state";

export type RepositoryBindOutcome =
  | { kind: "bound" | "already-bound"; binding: BindingValue }
  | { kind: "bound-elsewhere"; binding: BindingValue }
  | { kind: "unknown-mesh" | "conflict" | "busy" };

export type RepositoryUnbindOutcome =
  | { kind: "removed" | "not-this-computer"; binding: BindingValue }
  | { kind: "unknown-mesh" | "not-found" | "last-repository" | "busy" };

function sameRepository(item: RemovedBinding, binding: BindingValue): boolean {
  return item.projectId === binding.projectId && item.endpointId === binding.endpointId
    && item.repositoryId === binding.repositoryId;
}

export class MeshRepositoryStore extends MeshPreparedStore {
  /** Every binding this endpoint holds, in any Project. */
  endpointBindings(endpointId: string): BindingValue[] {
    this.sync();
    return this.state.bindings.filter((item) => item.endpointId === endpointId).map((item) => ({ ...item }));
  }

  /** Whether the person took this repository out of the Project on this endpoint. */
  bindingRemoved(projectId: string, endpointId: string, repositoryId: string): boolean {
    this.sync();
    return bindingRemoved(this.state, { projectId, endpointId, repositoryId });
  }

  /**
   * Bind one of this endpoint's checkouts to a Project. A repository this
   * endpoint already binds to another Project stays there; the removal on
   * record for this one, if any, is forgotten.
   */
  bindRepository(input: BindingValue): RepositoryBindOutcome {
    const result = this.transact((): RepositoryBindOutcome => {
      if (!this.state.projects.some((item) => item.projectId === input.projectId)) return { kind: "unknown-mesh" };
      const own = this.state.bindings.find((item) =>
        item.endpointId === input.endpointId && item.repositoryId === input.repositoryId);
      if (own) return { kind: own.projectId === input.projectId ? "already-bound" : "bound-elsewhere", binding: own };
      const removedBindings = this.state.removedBindings.filter((item) => !sameRepository(item, input));
      let bindings: BindingValue[];
      try {
        bindings = upsertBinding({ ...this.state, removedBindings }, input).bindings;
      } catch {
        return { kind: "conflict" };
      }
      this.state.removedBindings = removedBindings;
      this.state.bindings = bindings;
      return { kind: "bound", binding: input };
    });
    return result.applied ? result.value : { kind: "busy" };
  }

  /**
   * Take one of this endpoint's bindings out of a Project and keep a record
   * that it was taken out. Another computer's binding is that computer's to
   * remove, and a Project keeps at least one repository it can work in.
   */
  unbindRepository(projectId: string, bindingId: string, endpointId: string): RepositoryUnbindOutcome {
    const result = this.transact((): RepositoryUnbindOutcome => {
      if (!this.state.projects.some((item) => item.projectId === projectId)) return { kind: "unknown-mesh" };
      const binding = this.state.bindings.find((item) => item.bindingId === bindingId && item.projectId === projectId);
      if (!binding) return { kind: "not-found" };
      if (binding.endpointId !== endpointId) return { kind: "not-this-computer", binding };
      const others = this.state.bindings.filter((item) => item.projectId === projectId && item.bindingId !== bindingId);
      if (!others.some((item) => item.available)) return { kind: "last-repository" };
      this.state.bindings = this.state.bindings.filter((item) => item.bindingId !== bindingId);
      this.state.removedBindings = [
        ...this.state.removedBindings.filter((item) => !sameRepository(item, binding)),
        { projectId, endpointId, repositoryId: binding.repositoryId, at: this.now() },
      ].slice(-MAX_REMOVED_BINDINGS);
      // What the repository said about its neighbours leaves with it, unless another computer still binds it.
      if (!others.some((item) => item.repositoryId === binding.repositoryId)) {
        this.state.peers = this.state.peers.filter((item) =>
          !(item.projectId === projectId && item.repositoryId === binding.repositoryId));
      }
      return { kind: "removed", binding };
    });
    return result.applied ? result.value : { kind: "busy" };
  }
}
