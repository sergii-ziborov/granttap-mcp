import { inspectRepository } from "../catalog";
import { computerId } from "../identity/computer";
import { localMeshStore } from "../local-remote/local";
import { checkRepository } from "./check";
import { loadRestrictions, readRepoRestrictions } from "./store";

export type RestrictionsCheckResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Same decision the `granttap restrictions check` bin prints. */
export function runRestrictionsCheck(root: string): RestrictionsCheckResult {
  const repository = inspectRepository(root);
  const projectId = localMeshStore().projectIdForRepository(
    repository.canonicalRepositoryId, computerId(),
  );
  const restrictions = readRepoRestrictions(root, projectId ?? "ci")
    ?? (projectId ? loadRestrictions(projectId) : undefined);

  if (!restrictions || restrictions.rules.length === 0) {
    return { exitCode: 0, stdout: "GrantTap restrictions: none configured.\n", stderr: "" };
  }

  const violations = checkRepository(root, restrictions);
  if (violations.length === 0) {
    return {
      exitCode: 0,
      stdout: `GrantTap restrictions: ${restrictions.rules.length} rule(s) clean.\n`,
      stderr: "",
    };
  }

  const stderr = violations
    .map((item) => `${item.effect.toUpperCase()} ${item.reason}\n`)
    .join("");
  const denied = violations.some((item) => item.effect === "deny");
  return { exitCode: denied ? 1 : 0, stdout: "", stderr };
}
