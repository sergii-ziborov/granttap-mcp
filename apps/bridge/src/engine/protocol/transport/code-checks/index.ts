import { EngineProtocolError } from "../protocol-base";

/** Missing checks stay unknown; present checks must be bounded measurements. */
export function parseCodeChecks(value: unknown): void {
  if (value == null) return;
  const checks = value as Record<string, unknown>;
  if (typeof checks !== "object" || Array.isArray(checks) || checks.measured !== true
    || !["source_lines", "cyclomatic", "max_loop_depth", "callers"].every(key =>
      Number.isSafeInteger(checks[key]) && Number(checks[key]) >=
        (["source_lines", "cyclomatic"].includes(key) ? 1 : 0)
        && Number(checks[key]) <= 0xffff_ffff)) {
    throw new EngineProtocolError("invalid measured code checks");
  }
}
