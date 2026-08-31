import type {
  CapabilityFingerprint,
  CapabilityKind,
  EnforcementStatus,
  EnginePolicyDecision,
  PolicyEffect,
} from "./engine-policy-types";

export type EnginePolicyEnforcement = "best_available" | "strict";
export type EngineFingerprintPredicate =
  | { match: "exact" | "changed_from"; expected: CapabilityFingerprint }
  | { match: "confidence"; value: "exact" | "strong" | "name_only" | "unknown" };
export type EnginePolicyRule = {
  rule_id: string;
  project_id: string;
  selector: {
    kind?: CapabilityKind;
    display_name?: string;
    provider?: string;
    origin?: string;
    fingerprint?: EngineFingerprintPredicate;
  };
  effect: Exclude<PolicyEffect, "inherit">;
  conditions: {
    endpoint_ids: string[];
    providers: string[];
    impact?: "any" | "available" | "missing";
  };
  revision: number;
  created_by: string;
};
export type EngineProjectPolicy = {
  project_id: string;
  revision: number;
  enforcement: EnginePolicyEnforcement;
  rules: EnginePolicyRule[];
};
export type EngineCapabilityCoverage = { kind: CapabilityKind; status: EnforcementStatus };
export type EnginePolicyAcknowledgement = {
  project_id: string;
  policy_revision: number;
  endpoint_id: string;
  provider: string;
  capabilities: EngineCapabilityCoverage[];
  observed_at: number;
};
export type EnginePolicyCoverage = {
  project_id: string;
  policy_revision: number;
  enforcement: EnginePolicyEnforcement;
  required_capabilities: CapabilityKind[];
  endpoints: EnginePolicyAcknowledgement[];
  strict_ready: boolean;
};

export type EnginePolicyOperation =
  | { operation: "policy.get"; input: { project_id: string } }
  | {
    operation: "policy.apply";
    input: { expected_revision: number; policy: EngineProjectPolicy };
  }
  | {
    operation: "policy.evaluate_action";
    input: {
      provider?: PolicyEffect;
      account?: PolicyEffect;
      project?: PolicyEffect;
      task?: PolicyEffect;
      project_id?: string;
      endpoint_id?: string;
      capability?: CapabilityFingerprint;
      impact_available?: boolean;
    };
  }
  | { operation: "policy.coverage"; input: { project_id: string } }
  | {
    operation: "policy.ack";
    input: { acknowledgement: EnginePolicyAcknowledgement };
  };

export type EnginePolicyResult =
  | { operation: "policy.found"; policy: EngineProjectPolicy }
  | { operation: "policy.applied"; policy: EngineProjectPolicy }
  | { operation: "policy.evaluated"; decision: EnginePolicyDecision }
  | { operation: "policy.coverage"; coverage: EnginePolicyCoverage }
  | { operation: "policy.acknowledged"; acknowledgement: EnginePolicyAcknowledgement };

type Wire = Record<string, unknown>;

export function parsePolicyResult(result: Wire, invalid: () => never): boolean {
  if (result.operation === "policy.found") {
    parsePolicy(result.policy, true, invalid);
    return true;
  }
  if (result.operation === "policy.applied") {
    parsePolicy(result.policy, false, invalid);
    return true;
  }
  if (result.operation === "policy.evaluated") {
    parseDecision(result.decision, invalid);
    return true;
  }
  if (result.operation === "policy.coverage") {
    parseCoverage(result.coverage, invalid);
    return true;
  }
  if (result.operation === "policy.acknowledged") {
    parseAcknowledgement(result.acknowledgement, invalid);
    return true;
  }
  return false;
}

function parsePolicy(value: unknown, allowEmpty: boolean, invalid: () => never): void {
  const policy = object(value, invalid);
  string(policy.project_id, invalid);
  positive(policy.revision, invalid, !allowEmpty);
  if (!enforcement(policy.enforcement) || !Array.isArray(policy.rules)
    || policy.rules.length > 256) invalid();
  if (policy.revision === 0
    && (policy.enforcement !== "best_available" || policy.rules.length !== 0)) invalid();
  const ids = new Set<string>();
  for (const value of policy.rules) parseRule(value, policy, invalid);
  for (const value of policy.rules) {
    const rule = object(value, invalid);
    if (!ids.add(String(rule.rule_id))) invalid();
  }
}

function parseRule(value: unknown, policy: Wire, invalid: () => never): void {
  const rule = object(value, invalid);
  string(rule.rule_id, invalid);
  if (rule.project_id !== policy.project_id || rule.revision !== policy.revision
    || !["allow", "ask", "deny"].includes(String(rule.effect))) invalid();
  string(rule.created_by, invalid);
  parseSelector(rule.selector, invalid);
  const conditions = object(rule.conditions, invalid);
  stringArray(conditions.endpoint_ids, 64, invalid);
  stringArray(conditions.providers, 64, invalid);
  if (conditions.impact != null
    && !["any", "available", "missing"].includes(String(conditions.impact))) invalid();
}

function parseDecision(value: unknown, invalid: () => never): void {
  const decision = object(value, invalid);
  if (!["inherit", "allow", "ask", "deny"].includes(String(decision.effect))
    || !["none", "provider", "account", "project", "task"].includes(String(decision.source))) {
    invalid();
  }
  string(decision.reason, invalid);
  if (decision.rule_id != null) string(decision.rule_id, invalid);
  if (decision.policy_revision != null) positive(decision.policy_revision, invalid, false);
  if (decision.fingerprint_confidence != null
    && !confidence(decision.fingerprint_confidence)) invalid();
  if (decision.coverage != null && !status(decision.coverage)) invalid();
}

function parseCoverage(value: unknown, invalid: () => never): void {
  const coverage = object(value, invalid);
  string(coverage.project_id, invalid);
  positive(coverage.policy_revision, invalid, false);
  if (!enforcement(coverage.enforcement) || !Array.isArray(coverage.required_capabilities)
    || !Array.isArray(coverage.endpoints) || coverage.endpoints.length > 32
    || typeof coverage.strict_ready !== "boolean") invalid();
  coverage.required_capabilities.forEach((item) => {
    if (!capability(item)) invalid();
  });
  if (new Set(coverage.required_capabilities).size !== coverage.required_capabilities.length) {
    invalid();
  }
  const endpoints = new Set<string>();
  coverage.endpoints.forEach((item) => {
    parseAcknowledgement(item, invalid);
    const acknowledgement = item as EnginePolicyAcknowledgement;
    if (acknowledgement.project_id !== coverage.project_id
      || acknowledgement.policy_revision !== coverage.policy_revision
      || !endpoints.add(`${acknowledgement.endpoint_id}\0${acknowledgement.provider}`)) invalid();
  });
}

function parseAcknowledgement(value: unknown, invalid: () => never): void {
  const acknowledgement = object(value, invalid);
  string(acknowledgement.project_id, invalid);
  string(acknowledgement.endpoint_id, invalid);
  string(acknowledgement.provider, invalid);
  positive(acknowledgement.policy_revision, invalid, true);
  positive(acknowledgement.observed_at, invalid, false);
  if (!Array.isArray(acknowledgement.capabilities)
    || acknowledgement.capabilities.length > 8) invalid();
  const kinds = new Set<string>();
  for (const value of acknowledgement.capabilities) {
    const item = object(value, invalid);
    if (!capability(item.kind) || !status(item.status) || !kinds.add(String(item.kind))) invalid();
  }
}

function parseSelector(value: unknown, invalid: () => never): void {
  const selector = object(value, invalid);
  if (selector.kind != null && !capability(selector.kind)) invalid();
  for (const field of ["display_name", "provider", "origin"] as const) {
    if (selector[field] != null) string(selector[field], invalid);
  }
  if (selector.fingerprint != null) parsePredicate(selector.fingerprint, invalid);
}

function parsePredicate(value: unknown, invalid: () => never): void {
  const predicate = object(value, invalid);
  if (predicate.match === "confidence") {
    if (!confidence(predicate.value)) invalid();
  } else if (predicate.match === "exact" || predicate.match === "changed_from") {
    parseFingerprint(predicate.expected, invalid);
  } else invalid();
}

function parseFingerprint(value: unknown, invalid: () => never): void {
  const fingerprint = object(value, invalid);
  if (!capability(fingerprint.kind) || !confidence(fingerprint.confidence)) invalid();
  string(fingerprint.display_name, invalid);
  for (const field of ["provider", "origin", "publisher", "version", "transport"] as const) {
    if (fingerprint[field] != null) string(fingerprint[field], invalid);
  }
  for (const field of ["executable_path_hash", "config_hash", "script_hash"] as const) {
    if (fingerprint[field] != null
      && (typeof fingerprint[field] !== "string"
        || !/^[0-9a-f]{64}$/i.test(fingerprint[field] as string))) invalid();
  }
}

function stringArray(value: unknown, maximum: number, invalid: () => never): void {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  value.forEach((item) => string(item, invalid));
}

function object(value: unknown, invalid: () => never): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Wire;
}

function string(value: unknown, invalid: () => never): void {
  if (typeof value !== "string" || value.length === 0) invalid();
}

function positive(value: unknown, invalid: () => never, nonzero: boolean): void {
  if (!Number.isSafeInteger(value) || Number(value) < (nonzero ? 1 : 0)) invalid();
}

function enforcement(value: unknown): value is EnginePolicyEnforcement {
  return value === "best_available" || value === "strict";
}

function capability(value: unknown): value is CapabilityKind {
  return ["agent", "mcp", "skill", "shell", "script", "file_write", "deploy", "network"]
    .includes(String(value));
}

function confidence(value: unknown): boolean {
  return ["exact", "strong", "name_only", "unknown"].includes(String(value));
}

function status(value: unknown): boolean {
  return ["enforced", "observed", "unsupported", "unknown"].includes(String(value));
}
