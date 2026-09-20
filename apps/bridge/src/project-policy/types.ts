import type { RelayClient } from "../../../../packages/core/relay-client";
import type {
  ProjectCapabilityKind,
  ProjectEnforcementStatus,
  ProjectPolicyPayload,
  ProjectPolicyRejectionReason,
} from "../../../../packages/protocol/schema";
import type { EngineClientLike } from "../engine/runtime/engine-supervisor";

export type ProviderCoverageTarget = {
  provider: "claude" | "codex" | "cursor" | "grok";
  hookConfigured: boolean;
};

export type ProjectPolicyRuntimeDependencies = {
  client: EngineClientLike;
  endpointId: () => string;
  providers: () => ProviderCoverageTarget[];
  now: () => number;
  send: (relay: RelayClient, payload: ProjectPolicyPayload) => Promise<void>;
  log?: (line: string) => void;
};

export function rejectionReason(error: unknown): ProjectPolicyRejectionReason {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/revision|conflict|expected/i.test(message)) return "revision_mismatch";
  if (/ECONNREFUSED|ENOENT|EPIPE|socket|timed? ?out|unavailable|not running/i.test(message)) {
    return "engine_unavailable";
  }
  if (/invalid|schema|malformed|scope/i.test(message)) return "invalid_policy";
  return "unknown";
}

export function enforcementCoverageFor(
  provider: "claude" | "codex" | "cursor" | "grok",
  kind: ProjectCapabilityKind,
  hookConfigured = true,
): ProjectEnforcementStatus {
  if (provider === "grok") return kind === "shell" ? "observed" : "unsupported";
  if (kind === "agent") return "unsupported";
  if (!hookConfigured) return "unknown";
  if (provider === "cursor" && (kind === "skill" || kind === "file_write")) {
    return "unsupported";
  }
  return "enforced";
}
