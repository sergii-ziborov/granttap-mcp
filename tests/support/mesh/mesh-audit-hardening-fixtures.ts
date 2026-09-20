/**
 * What the Mesh audit found, and what now holds instead.
 *
 * Each test here is one finding: a claim released by a stranger, a handoff
 * started by an agent, two processes writing one file, a store file quietly
 * replaced, a rejoined chat whose events no longer parsed, a prompt that
 * marked unread what it never showed, a tool call attributed to the wrong
 * chat, an attachment taken by another pairing, a governed Project that fell
 * open when the engine was silent.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayClient } from "../../../packages/core/relay-client";
import type { MeshEvent, MeshSnapshot, SessionInfo, TaskCapsule } from "../../../packages/protocol/schema";
import { storeAttachment, takeAttachment } from "../../../apps/bridge/src/delivery/attachment-store";
import { consumeAttributedCall, recordAttributedCall } from "../../../apps/bridge/src/mesh/identity/call-scope";
import { checkpointBranchName } from "../../../apps/bridge/src/mesh/admin/checkpoint";
import { capsuleHash } from "../../../apps/bridge/src/mesh/handoff";
import { markRunsDelivered, recordRun, unreadRuns, type RunRecord } from "../../../apps/bridge/src/mesh/admin/journal";
import { MAX_CONTEXT_CHARS, promptContext } from "../../../apps/bridge/src/mesh/context/prompt";
import { createMeshRuntime, type MeshRuntimeDependencies } from "../../../apps/bridge/src/mesh/runtime";
import { MeshStore } from "../../../apps/bridge/src/mesh/store";
import { emptyStoreState, type StoreState } from "../../../apps/bridge/src/mesh/store/state";
import {
  applyStoreDelta, deltaIsEmpty, storeDelta, StoreLockError, withStoreLock,
} from "../../../apps/bridge/src/mesh/store/sync";
import { secretFilePath } from "../../../apps/bridge/src/sessions/support/edit-stats";
import {
  evaluateEffectiveAction,
  legacyGrantTapFlowAllowed,
} from "../../../apps/bridge/src/policy/effective-action";
import { governedRevision, rememberGovernedProject } from "../../../apps/bridge/src/policy/governed-projects";
import type { EngineClientLike } from "../../../apps/bridge/src/engine/runtime/engine-supervisor";

const now = 1_800_000_000_000;

const client = {} as RelayClient;

function project(projectId = "project") {
  return {
    projectId, name: "GrantTap", repositoryRoot: "/repo",
    canonicalRepositoryId: "github.com/example/granttap", createdAt: now,
  };
}

function task(taskId = "task", overrides: Record<string, unknown> = {}) {
  return {
    taskId, projectId: "project", title: "Pairing", goal: "Finish pairing",
    state: "working" as const, ownerSessionId: "claude", createdAt: now, updatedAt: now, ...overrides,
  };
}

function event(
  id: string,
  eventType: MeshEvent["eventType"],
  payload: MeshEvent["payload"],
  overrides: Partial<MeshEvent> = {},
): MeshEvent {
  return {
    type: "mesh.event", sessionId: "task", eventId: id, projectId: "project", taskId: "task",
    sourceSessionId: "claude", eventType, createdAt: now + id.length, expiresAt: now + 60_000,
    payload, ...overrides,
  };
}

function claim(claimId = "claim") {
  return {
    claimId, projectId: "project", taskId: "task", ownerSessionId: "claude",
    resource: "src/auth/**", mode: "claim" as const, createdAt: now, expiresAt: now + 60_000,
  };
}

async function isolatedConfig(t: { after: (fn: () => void) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "granttap-audit-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = join(root, "config");
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });
  return root;
}

function capsule(overrides: Partial<TaskCapsule> = {}): TaskCapsule {
  return {
    taskId: "task", goal: "Finish pairing", currentStatus: "Crypto complete",
    sourceProvider: "claude", sourceComputer: "MacBook", targetProvider: "codex",
    targetComputer: "Workstation", repository: "github.com/example/granttap",
    baseSha: "a".repeat(40), latestCommit: "b".repeat(40), filesChanged: ["src/auth/login.ts"],
    dependencies: [], resourceClaims: [], remainingWork: [], importantDecisions: [],
    createdAt: now, ...overrides,
  };
}

function handoff(id: string): MeshEvent {
  return event(id, "HANDOFF_REQUEST", { capsule: capsule() }, { sourceSessionId: "claude-source" });
}

function run(at: number, outcome = "Done."): RunRecord {
  return { at, endedAt: at + 1_000, source: "phone", prompt: `Message at ${at}`, ok: true, outcome, files: [], tools: 1 };
}

export { now, client, project, task, event, claim, isolatedConfig, capsule, handoff, run };
