#!/usr/bin/env -S npx tsx
/**
 * CI entry for Project restrictions: the same rules Mesh stores, read from
 * `.granttap/restrictions.json` in the repository (or the Mesh store when
 * this computer already holds that Project).
 */
import { resolve } from "node:path";
import { inspectRepository } from "../mesh/catalog";
import { computerId } from "../mesh/computer-identity";
import { localMeshStore } from "../mesh/local";
import {
  checkRepository,
  loadRestrictions,
  readRepoRestrictions,
} from "../mesh/restrictions";

const root = resolve(process.argv[2] ?? process.cwd());
const repository = inspectRepository(root);
const projectId = localMeshStore().projectIdForRepository(
  repository.canonicalRepositoryId, computerId(),
);
const restrictions = readRepoRestrictions(root, projectId ?? "ci")
  ?? (projectId ? loadRestrictions(projectId) : undefined);

if (!restrictions || restrictions.rules.length === 0) {
  process.stdout.write("GrantTap restrictions: none configured.\n");
  process.exit(0);
}

const violations = checkRepository(root, restrictions);
if (violations.length === 0) {
  process.stdout.write(
    `GrantTap restrictions: ${restrictions.rules.length} rule(s) clean.\n`,
  );
  process.exit(0);
}

for (const item of violations) {
  process.stderr.write(`${item.effect.toUpperCase()} ${item.reason}\n`);
}
const denied = violations.some((item) => item.effect === "deny");
process.exit(denied ? 1 : 0);
