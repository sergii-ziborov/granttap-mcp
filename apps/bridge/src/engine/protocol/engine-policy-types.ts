export type PolicyEffect = "inherit" | "allow" | "ask" | "deny";
export type PolicySource = "none" | "provider" | "account" | "project" | "task";
export type CapabilityKind =
  | "agent"
  | "mcp"
  | "skill"
  | "shell"
  | "script"
  | "file_write"
  | "deploy"
  | "network";
export type FingerprintConfidence = "exact" | "strong" | "name_only" | "unknown";
export type EnforcementStatus = "enforced" | "observed" | "unsupported" | "unknown";

export type CapabilityFingerprint = {
  kind: CapabilityKind;
  display_name: string;
  provider?: string;
  origin?: string;
  publisher?: string;
  version?: string;
  transport?: string;
  executable_path_hash?: string;
  config_hash?: string;
  script_hash?: string;
  confidence: FingerprintConfidence;
};

export type EnginePolicyDecision = {
  effect: PolicyEffect;
  source: PolicySource;
  reason: string;
  rule_id?: string;
  policy_revision?: number;
  fingerprint_confidence?: FingerprintConfidence;
  coverage?: EnforcementStatus;
};
