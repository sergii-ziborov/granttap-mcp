import { join } from "node:path";
import { configDir } from "../../../config/runtime/paths";
import { EngineClient } from "../engine-client";
import { engineFeatureEnabled, type EngineClientLike } from "../engine-supervisor";
import { EngineRemoteError } from "../../protocol/transport/protocol-base";
import type { EngineCodeFile } from "../../protocol/code-file";

export type CodeFileRead =
  | { kind: "ok"; file: EngineCodeFile }
  /** The Engine has not analysed the repository since it started; an analysis fills its memory. */
  | { kind: "not_cached" }
  | { kind: "not_found" | "not_bound" | "engine_unavailable" | "analysis_failed" };

export type CodeFileReadOptions = { env?: NodeJS.ProcessEnv; client?: EngineClientLike; timeoutMs?: number };

const MAX_ENGINE_PATH_BYTES = 512;
const READ_TIMEOUT_MS = 10_000;

/**
 * One file's sections from the Engine's memory of its last `graph.analyze_repository`. It never
 * scans: a repository the Engine has not analysed since it started answers `not_cached`.
 */
export async function readEngineCodeFile(
  input: { projectId: string; repositoryId: string; path: string }, options: CodeFileReadOptions = {},
): Promise<CodeFileRead> {
  if (!engineFeatureEnabled(options.env ?? process.env)) return { kind: "engine_unavailable" };
  // The Engine's paths are at most 512 bytes; a longer one names no file it holds.
  if (Buffer.byteLength(input.path, "utf8") > MAX_ENGINE_PATH_BYTES) return { kind: "not_found" };
  // Its own short-lived socket: a read never waits behind policy or Backbone requests.
  const channel = options.client ?? new EngineClient({
    socketPath: join(configDir(), "engine.sock"), connectTimeoutMs: 5_000,
  });
  try {
    const result = await channel.request({ operation: "graph.code_file", input: {
      project_id: input.projectId, repository_id: input.repositoryId, path: input.path,
    } }, { timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS });
    if (result.operation !== "graph.code_file" || result.file.project_id !== input.projectId
      || result.file.repository_id !== input.repositoryId || result.file.path !== input.path) {
      return { kind: "engine_unavailable" };
    }
    return { kind: "ok", file: result.file };
  } catch (error) {
    return { kind: codeFileFailure(error) };
  } finally {
    if (!options.client) channel.close();
  }
}

/**
 * An Engine before 0.1.10 refuses the unknown operation as `INVALID_REQUEST`; like a socket that is
 * not there, that is an Engine that cannot answer.
 */
export function codeFileFailure(error: unknown): Exclude<CodeFileRead["kind"], "ok"> {
  if (!(error instanceof EngineRemoteError)) return "engine_unavailable";
  if (error.code === "CODE_MAP_NOT_CACHED") return "not_cached";
  if (error.code === "CODE_FILE_NOT_FOUND" || error.code === "INVALID_OPERATION") return "not_found";
  if (["REPOSITORY_NOT_BOUND", "REPOSITORY_NOT_LOCAL", "REPOSITORY_IDENTITY_MISMATCH",
    "REPOSITORY_IDENTITY_UNVERIFIED"].includes(error.code)) return "not_bound";
  if (error.code.startsWith("WEAVATRIX_")) return "analysis_failed";
  return "engine_unavailable";
}
