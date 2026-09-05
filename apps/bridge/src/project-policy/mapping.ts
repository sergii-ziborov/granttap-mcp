import type {
  ProjectCapabilityFingerprint,
  ProjectPolicy,
  ProjectPolicyAcknowledgement,
  ProjectPolicyCoverage,
  ProjectPolicyRule,
} from "../../../../packages/protocol/schema";
import type {
  EnginePolicyAcknowledgement,
  EnginePolicyCoverage,
  EnginePolicyRule,
  EngineProjectPolicy,
} from "../engine/engine-policy-protocol";
import type { CapabilityFingerprint } from "../engine/engine-policy-types";

export function policyToEngine(policy: ProjectPolicy): EngineProjectPolicy {
  return {
    project_id: policy.projectId,
    revision: policy.revision,
    enforcement: policy.enforcement,
    rules: policy.rules.map(ruleToEngine),
  };
}

export function policyFromEngine(policy: EngineProjectPolicy): ProjectPolicy {
  return {
    projectId: policy.project_id,
    revision: policy.revision,
    enforcement: policy.enforcement,
    rules: policy.rules.map(ruleFromEngine),
  };
}

export function acknowledgementFromEngine(
  value: EnginePolicyAcknowledgement,
): ProjectPolicyAcknowledgement {
  return {
    projectId: value.project_id,
    policyRevision: value.policy_revision,
    endpointId: value.endpoint_id,
    provider: provider(value.provider),
    capabilities: value.capabilities,
    observedAt: value.observed_at,
  };
}

export function coverageFromEngine(value: EnginePolicyCoverage): ProjectPolicyCoverage {
  return {
    projectId: value.project_id,
    policyRevision: value.policy_revision,
    enforcement: value.enforcement,
    requiredCapabilities: value.required_capabilities,
    endpoints: value.endpoints.map(acknowledgementFromEngine),
    strictReady: value.strict_ready,
  };
}

function ruleToEngine(rule: ProjectPolicyRule): EnginePolicyRule {
  return {
    rule_id: rule.ruleId,
    project_id: rule.projectId,
    selector: {
      kind: rule.selector.kind,
      display_name: rule.selector.displayName,
      provider: rule.selector.provider,
      origin: rule.selector.origin,
      fingerprint: rule.selector.fingerprint && (
        rule.selector.fingerprint.match === "confidence"
          ? { match: "confidence", value: rule.selector.fingerprint.value }
          : {
            match: rule.selector.fingerprint.match,
            expected: fingerprintToEngine(rule.selector.fingerprint.expected),
          }
      ),
    },
    effect: rule.effect,
    conditions: {
      endpoint_ids: rule.conditions.endpointIds,
      providers: rule.conditions.providers,
      impact: rule.conditions.impact,
    },
    revision: rule.revision,
    created_by: rule.createdBy,
  };
}

/**
 * An absent field is absent, not null.
 *
 * The engine answers with explicit nulls for every selector field it does not
 * use. The wire schema says those fields are optional, and the phone checks
 * the shape strictly before it reads a status — so a status with `null` in it
 * was dropped on the phone without a word, and Governance showed "no rules"
 * while the computer was enforcing two.
 */
function present<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined) out[key] = item;
  }
  return out as T;
}

function ruleFromEngine(rule: EnginePolicyRule): ProjectPolicyRule {
  const fingerprint = rule.selector.fingerprint;
  return {
    ruleId: rule.rule_id,
    projectId: rule.project_id,
    selector: present({
      kind: rule.selector.kind,
      displayName: rule.selector.display_name,
      provider: optionalProvider(rule.selector.provider),
      origin: rule.selector.origin,
      fingerprint: fingerprint && (
        fingerprint.match === "confidence"
          ? { match: "confidence", value: fingerprint.value }
          : { match: fingerprint.match, expected: present(fingerprintFromEngine(fingerprint.expected)) }
      ),
    }),
    effect: rule.effect,
    conditions: present({
      endpointIds: rule.conditions.endpoint_ids,
      providers: rule.conditions.providers.map(provider),
      impact: rule.conditions.impact,
    }),
    revision: rule.revision,
    createdBy: rule.created_by,
  };
}

function fingerprintToEngine(value: ProjectCapabilityFingerprint): CapabilityFingerprint {
  return {
    kind: value.kind,
    display_name: value.displayName,
    provider: value.provider,
    origin: value.origin,
    publisher: value.publisher,
    version: value.version,
    transport: value.transport,
    executable_path_hash: value.executablePathHash,
    config_hash: value.configHash,
    script_hash: value.scriptHash,
    confidence: value.confidence,
  };
}

function fingerprintFromEngine(value: CapabilityFingerprint): ProjectCapabilityFingerprint {
  return {
    kind: value.kind,
    displayName: value.display_name,
    provider: optionalProvider(value.provider),
    origin: value.origin,
    publisher: value.publisher,
    version: value.version,
    transport: value.transport,
    executablePathHash: value.executable_path_hash,
    configHash: value.config_hash,
    scriptHash: value.script_hash,
    confidence: value.confidence,
  };
}

function provider(value: string): "claude" | "codex" | "cursor" | "grok" {
  const normalized = value.trim().toLowerCase();
  if (["claude", "codex", "cursor", "grok"].includes(normalized)) {
    return normalized as "claude" | "codex" | "cursor" | "grok";
  }
  throw new Error("engine returned an unsupported policy provider");
}

function optionalProvider(value?: string): "claude" | "codex" | "cursor" | "grok" | undefined {
  return value == null ? undefined : provider(value);
}
