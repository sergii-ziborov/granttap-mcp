import { z } from "zod";
import { Identifier } from "../endpoint";
import { CodePath, CodeSymbol } from "./code-map";

/** Most sections one answer lists; `totalSymbols` still counts the rest. */
export const MAX_CODE_FILE_SYMBOLS = 2_000;
/** Largest serialized `project.code_file.result`; trailing sections make way first. */
export const MAX_CODE_FILE_RESULT_BYTES = 160 * 1_024;

const scope = {
  projectId: Identifier,
  repositoryId: z.string().trim().min(1).max(512),
  path: CodePath,
  requestId: z.string().min(1).max(128),
};

/**
 * The phone asks the computer that published a repository's code map for every section of one file.
 * The Mesh snapshot keeps its bounded overview; this answer is for one file only.
 */
export const ProjectCodeFileQuery = z.object({
  type: z.literal("project.code_file.query"),
  ...scope,
  createdAt: z.number().finite(),
}).strict();
export type ProjectCodeFileQuery = z.infer<typeof ProjectCodeFileQuery>;

/**
 * `analyzing` means keep waiting: the computer is filling its Engine's code map and answers again.
 * Every status but `ok` carries no sections.
 */
export const ProjectCodeFileStatus = z.enum([
  "ok", "analyzing", "not_found", "not_bound", "engine_unavailable", "analysis_failed",
]);
export type ProjectCodeFileStatus = z.infer<typeof ProjectCodeFileStatus>;

export const ProjectCodeFileResult = z.object({
  type: z.literal("project.code_file.result"),
  ...scope,
  status: ProjectCodeFileStatus,
  revision: z.string().trim().min(1).max(512).optional(),
  analysisId: z.string().trim().min(1).max(128).optional(),
  language: z.string().trim().min(1).max(64).optional(),
  lineCount: z.number().int().positive().optional(),
  symbols: z.array(CodeSymbol).max(MAX_CODE_FILE_SYMBOLS),
  totalSymbols: z.number().int().nonnegative(),
  truncated: z.boolean(),
  createdAt: z.number().finite(),
}).strict().superRefine((value, ctx) => {
  if (value.status !== "ok" && value.symbols.length > 0) {
    ctx.addIssue({ code: "custom", path: ["symbols"], message: "only an ok answer carries sections" });
  }
  if (value.totalSymbols < value.symbols.length) {
    ctx.addIssue({ code: "custom", path: ["totalSymbols"], message: "total cannot be below the listed sections" });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_CODE_FILE_RESULT_BYTES) {
    ctx.addIssue({ code: "custom", path: ["symbols"], message: "code file answer exceeds its byte budget" });
  }
});
export type ProjectCodeFileResult = z.infer<typeof ProjectCodeFileResult>;
