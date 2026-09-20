import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MeshEvent, SessionInfo, TaskCapsule } from "../../../packages/protocol/schema";
import {
  hasUncommittedWork,
  linkSessionsToProjects,
  meshTaskTitle,
} from "../../../apps/bridge/src/mesh/catalog";
import { preferExecution, preferTask } from "../../../apps/bridge/src/mesh/admin/convergence";
import { handoffReceipt } from "../../../apps/bridge/src/mesh/handoff";
import {
  UNCOMMITTED_WORK_REASON,
  UNREADABLE_WORKING_TREE_REASON,
  handoffReadiness,
} from "../../../apps/bridge/src/mesh/tasks/readiness";
import { MeshStore } from "../../../apps/bridge/src/mesh/store";

const now = 1_800_000_000_000;

async function freshStore(): Promise<MeshStore> {
  const root = await mkdtemp(join(tmpdir(), "granttap-mesh-convergence-"));
  return new MeshStore(join(root, "mesh.json"), () => now);
}

function project() {
  return {
    projectId: "project", name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  };
}

function capsuleTo(targetProvider: "codex" | "cursor"): TaskCapsule {
  return {
    taskId: "task", goal: "Finish pairing", currentStatus: "Crypto complete",
    sourceProvider: "claude", sourceComputer: "MacBook", targetProvider,
    targetComputer: "Workstation", repository: "github.com/example/granttap",
    baseSha: "a".repeat(40), filesChanged: [], dependencies: [], resourceClaims: [],
    remainingWork: [], importantDecisions: [], workingTree: "clean", createdAt: now,
  };
}

function event(
  eventId: string,
  eventType: MeshEvent["eventType"],
  payload: MeshEvent["payload"],
  sourceSessionId = "claude",
): MeshEvent {
  return {
    type: "mesh.event", sessionId: "task", eventId, projectId: "project", taskId: "task",
    sourceSessionId, eventType, createdAt: now + eventId.length, payload,
  };
}

async function handedOffStore(): Promise<MeshStore> {
  const store = await freshStore();
  store.upsertProject(project());
  store.upsertTask({
    taskId: "task", projectId: "project", title: "Pairing", goal: "Finish pairing",
    state: "working", ownerSessionId: "claude", createdAt: now, updatedAt: now,
  });
  store.linkExecution({
    taskId: "task", sessionId: "claude", provider: "claude", computerId: "MacBook",
    workspace: "/repo", branch: "main", startedAt: now,
  });
  return store;
}

export { now, freshStore, project, capsuleTo, event, handedOffStore };
