import { codexPolicyReady } from "../codex-hook-trust";
import { join } from "node:path";
import type { RelayClient } from "../../../../packages/core/relay-client";
import type { ProjectPolicySet } from "../../../../packages/protocol/schema";
import { loadRuntimeConfig } from "../config/runtime";
import { configDir } from "../config/runtime/paths";
import { EngineClient } from "../engine/runtime/engine-client";
import { engineFeatureEnabled } from "../engine/runtime/engine-supervisor";
import { inspectAgentIntegrations } from "../install";
import { sendProjectPayload } from "../host/session-keys";
import { computerId } from "../mesh/identity/computer";
import { applyPolicy, publishOne } from "./apply";
import type { ProjectPolicyRuntimeDependencies } from "./types";

export type { ProjectPolicyRuntimeDependencies } from "./types";
export { enforcementCoverageFor, rejectionReason } from "./types";

export function createProjectPolicyRuntime(deps: ProjectPolicyRuntimeDependencies) {
  return {
    apply: (relay: RelayClient | undefined, request: ProjectPolicySet) => applyPolicy(deps, relay, request),
    publish: async (relay: RelayClient | undefined, projectIds: string[]) => {
      for (const projectId of [...new Set(projectIds)].sort()) {
        await publishOne(deps, relay, projectId);
      }
    },
  };
}

export function projectPolicyFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const enabled = env.GRANTTAP_PROJECT_POLICY_ENABLED?.trim().toLowerCase();
  return engineFeatureEnabled(env) && (enabled === "1" || enabled === "true");
}

let sharedClient: EngineClient | undefined;

export function projectPolicyRuntimeDependencies(): ProjectPolicyRuntimeDependencies {
  sharedClient ??= new EngineClient({ socketPath: join(configDir(), "engine.sock") });
  return {
    client: sharedClient,
    log: (line) => process.stderr.write(`[monitor] rules: ${line}\n`),
    endpointId: computerId,
    providers: () => {
      const configured = loadRuntimeConfig().providerSettings;
      return inspectAgentIntegrations()
        .filter((item) => item.installed && configured[item.agent])
        .map((item) => ({ provider: item.agent,
          hookConfigured: item.hookConfigured && (item.agent !== "codex" || codexPolicyReady(item.hooks)) }));
    },
    now: Date.now,
    send: async (relay, payload) => {
      if (!relay) throw new Error("Relay delivery is unavailable");
      await sendProjectPayload(relay, payload, "phone", { ttlMs: 24 * 60 * 60_000 });
    },
  };
}

export function handleProjectPolicySet(
  relay: RelayClient | undefined,
  request: ProjectPolicySet,
): Promise<boolean> {
  if (!projectPolicyFeatureEnabled()) return Promise.resolve(false);
  return createProjectPolicyRuntime(projectPolicyRuntimeDependencies()).apply(relay, request);
}

export function publishProjectPolicyStatuses(
  relay: RelayClient | undefined,
  projectIds: string[],
): Promise<void> {
  if (!projectPolicyFeatureEnabled()) return Promise.resolve();
  return createProjectPolicyRuntime(projectPolicyRuntimeDependencies()).publish(relay, projectIds);
}
