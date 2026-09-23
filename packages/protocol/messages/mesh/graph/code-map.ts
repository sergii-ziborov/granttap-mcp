import { z } from "zod";

const CodePath = z.string().trim().min(1).max(512).refine((value) =>
  !value.startsWith("/") && !value.split("/").includes(".."), "repository-relative path required");

export const ProjectCodeMap = z.object({
  files: z.array(z.object({
    path: CodePath,
    language: z.string().trim().min(1).max(64).nullable(),
    lineCount: z.number().int().positive().nullable(),
    symbols: z.array(z.object({
      id: z.string().trim().min(1).max(512),
      label: z.string().max(160),
      kind: z.string().trim().min(1).max(64),
      startLine: z.number().int().positive(),
      lineCount: z.number().int().positive(),
    }).strict()).max(72),
  }).strict()).max(650),
  externals: z.array(z.object({
    id: z.string().startsWith("ext:").min(5).max(512),
    label: z.string().max(160),
    kind: z.string().trim().min(1).max(64),
  }).strict()).max(24).optional(),
  roads: z.array(z.object({
    source: CodePath,
    target: CodePath,
    relation: z.string().trim().min(1).max(64),
  }).strict()).max(1_200),
  totalFiles: z.number().int().nonnegative(),
  totalExternals: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const paths = new Set(value.files.map((file) => file.path));
  const externals = new Set((value.externals ?? []).map((node) => node.id));
  const references = new Set([...paths, ...externals]);
  if (paths.size !== value.files.length || value.totalFiles < value.files.length
    || externals.size !== (value.externals?.length ?? 0)
    || (value.totalExternals ?? 0) < (value.externals?.length ?? 0)
    || value.roads.some((road) => !references.has(road.source) || !references.has(road.target))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid code tower references" });
  }
});

export type ProjectCodeMap = z.infer<typeof ProjectCodeMap>;
