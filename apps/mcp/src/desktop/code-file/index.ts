import { ProjectCodeFileQuery, type ProjectCodeFileResult } from "../../../../../packages/protocol/schema";
import { CodeFileSections } from "../../../../bridge/src/code-file-sections";
import { defaultCodeFileDependencies } from "../../../../bridge/src/code-file-sections/analysis";
import { codeFileResult } from "../../../../bridge/src/code-file-sections/wire";
import type { EngineClient } from "../../../../bridge/src/engine/runtime/engine-client";
import { computerId } from "../../../../bridge/src/mesh/identity/computer";
import { MeshStore } from "../../../../bridge/src/mesh/store";

type DesktopEngine = Pick<EngineClient, "request">;

/** One coordinator per bridge Engine client: its reads share that channel, analyses get their own. */
const coordinators = new WeakMap<DesktopEngine, CodeFileSections>();

function coordinator(engine: DesktopEngine, storePath?: string): CodeFileSections {
  const known = coordinators.get(engine);
  if (known) return known;
  const store = storePath ? new MeshStore(storePath) : undefined;
  const sections = new CodeFileSections(defaultCodeFileDependencies({
    ...(store ? { snapshot: (projectId: string) => store.snapshot(projectId, computerId()) } : {}),
    read: { client: { request: engine.request.bind(engine), close() {} }, timeoutMs: 5_000 },
  }));
  coordinators.set(engine, sections);
  return sections;
}

/**
 * `desktop.code_file { project_id, repository_id, path, request_id? }`: the Mac app's own
 * `project.code_file.result`, in the same shape the phone receives. It never waits for an analysis:
 * a repository the Engine has not analysed since it started answers `analyzing`, and that analysis
 * runs on while the app asks again.
 */
export async function desktopCodeFile(input: unknown, options: { engine: DesktopEngine; storePath?: string }):
  Promise<{ operation: "desktop.code_file"; result: ProjectCodeFileResult } | undefined> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { project_id: projectId, repository_id: repositoryId, path, request_id: requestId } = input as Record<string, unknown>;
  const query = ProjectCodeFileQuery.safeParse({ type: "project.code_file.query", projectId, repositoryId, path,
    requestId: requestId ?? "local", createdAt: Date.now() });
  if (!query.success) return undefined;
  const answer = await coordinator(options.engine, options.storePath).poll(query.data);
  return { operation: "desktop.code_file", result: codeFileResult(query.data, answer, Date.now()) };
}
