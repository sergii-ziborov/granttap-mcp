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
  roads: z.array(z.object({
    source: CodePath,
    target: CodePath,
    relation: z.string().trim().min(1).max(64),
  }).strict()).max(1_200),
  totalFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const paths = new Set(value.files.map((file) => file.path));
  if (paths.size !== value.files.length || value.totalFiles < value.files.length
    || value.roads.some((road) => !paths.has(road.source) || !paths.has(road.target))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid code tower references" });
  }
});

export type ProjectCodeMap = z.infer<typeof ProjectCodeMap>;
