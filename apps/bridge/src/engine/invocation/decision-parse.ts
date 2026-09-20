import { sourceGapFact, type InvocationFact } from "./parse";

/** Metadata-only hook refusal. No arguments, outputs, or explanation text. */
export function parseInvocationDecision(
  line: string, provider: "claude" | "codex" | "cursor", offset: number,
): InvocationFact[] {
  let value: unknown;
  try { value = JSON.parse(line) as unknown; }
  catch { return [sourceGapFact(offset)]; }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [sourceGapFact(offset)];
  }
  const record = value as Record<string, unknown>;
  if (record.provider !== provider) return [];
  if (typeof record.nativeCallId !== "string" || !record.nativeCallId.trim()
    || record.nativeCallId.length > 128 || /[\u0000-\u001f]/.test(record.nativeCallId)
    || typeof record.toolName !== "string" || !record.toolName.trim()
    || record.toolName.length > 160 || /[\u0000-\u001f]/.test(record.toolName)
    || typeof record.at !== "number" || !Number.isSafeInteger(record.at) || record.at < 0) {
    return [sourceGapFact(offset)];
  }
  const revision = record.policyRevision;
  const rule = record.ruleId;
  const artifact = record.artifactHash;
  return [{
    callId: record.nativeCallId, toolName: record.toolName, phase: "denied",
    source: "hook", occurredAt: record.at,
    ...(typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0
      ? { policyRevision: revision } : {}),
    ...(typeof rule === "string" && rule.trim() && rule.length <= 128
      && !/[\u0000-\u001f]/.test(rule) ? { policyRuleId: rule } : {}),
    ...(typeof artifact === "string" && /^[a-f0-9]{64}$/i.test(artifact)
      ? { capabilityArtifactHash: artifact.toLowerCase() } : {}),
  }];
}
