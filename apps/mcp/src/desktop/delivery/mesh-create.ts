import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { configDir } from "../../../../bridge/src/config";
import { inspectRepository } from "../../../../bridge/src/mesh/catalog";
import { computerId } from "../../../../bridge/src/mesh/identity/computer";
import { projectBindingIdentity } from "../../../../bridge/src/mesh/identity";
import { MeshStore } from "../../../../bridge/src/mesh/store";

/** Create a named Mesh around one chosen repository; more bindings can join later. */
export function desktopMeshCreate(input: unknown,
  storePath = join(configDir(), "project-mesh.json"), endpoint = computerId()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const query = input as Record<string, unknown>;
  const name = typeof query.name === "string" ? query.name.trim() : "";
  const path = query.repository_path;
  if (!name || name.length > 160 || typeof path !== "string"
    || path.length > 1_024 || !isAbsolute(path)) return undefined;
  let root: string;
  try {
    root = realpathSync(path);
    if (!statSync(root).isDirectory()) return undefined;
    if (execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() !== "true") return undefined;
  } catch { return undefined; }
  const repository = inspectRepository(root);
  const store = new MeshStore(storePath);
  const existing = store.projectIdForRepository(repository.canonicalRepositoryId, endpoint);
  if (existing) return { operation: "desktop.mesh_create", created: false,
    project_id: existing, error: "This repository already belongs to a Mesh on this Mac." };
  const projectId = `mesh-${randomUUID()}`;
  store.upsertProject({ projectId, name, repositoryRoot: repository.root,
    canonicalRepositoryId: repository.canonicalRepositoryId,
    baseRemote: repository.baseRemote, createdAt: Date.now() });
  store.upsertBinding({
    bindingId: projectBindingIdentity(projectId, endpoint, repository.canonicalRepositoryId),
    projectId, endpointId: endpoint, repositoryId: repository.canonicalRepositoryId,
    displayName: basename(repository.root), localPathHint: repository.root,
    available: true, revision: repository.revision,
  });
  return { operation: "desktop.mesh_create", created: true, project_id: projectId,
    error: null };
}
