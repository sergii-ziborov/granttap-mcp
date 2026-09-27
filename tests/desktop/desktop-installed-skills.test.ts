import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopInstalledSkills } from "../../apps/mcp/src/desktop/projection/installed-skills";
import { inspectRepository } from "../../apps/bridge/src/mesh/catalog";
import { MeshStore } from "../../apps/bridge/src/mesh/store";

test("Mac reports installed Skills for bound Mesh workspaces only", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-desktop-skills-"));
  const repository = join(root, "repository");
  execFileSync("git", ["init", "-q", repository]);
  const skillName = `mesh-test-${randomUUID()}`;
  const skillRoot = join(repository, ".agents", "skills", skillName);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Project test Skill\n---\n`);
  const projectId = `test-${randomUUID()}`;
  const storePath = join(root, "mesh.json");
  const identity = inspectRepository(repository);
  const store = new MeshStore(storePath);
  store.upsertProject({ projectId, name: "Test Mesh", repositoryRoot: repository,
    canonicalRepositoryId: identity.canonicalRepositoryId, createdAt: Date.now() });
  store.upsertBinding({ bindingId: "binding", projectId, endpointId: "this-computer",
    repositoryId: identity.canonicalRepositoryId, displayName: "repository",
    localPathHint: repository, available: true });

  const foreign = desktopInstalledSkills({ project_id: projectId },
    storePath, "another-computer");
  assert.equal(foreign?.skills.some((skill) => skill.name === skillName), false);
  const local = desktopInstalledSkills({ project_id: projectId },
    storePath, "this-computer");
  assert.equal(local?.skills.find((skill) => skill.name === skillName)?.description,
    "Project test Skill");
  assert.equal(desktopInstalledSkills({ project_id: "missing" }, storePath,
    "this-computer"), undefined);
});
