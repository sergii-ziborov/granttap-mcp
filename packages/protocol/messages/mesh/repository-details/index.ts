import { z } from "zod";
import { Identifier } from "../endpoint";

export const ProjectRepositoryDetails = z.object({
  projectId: Identifier,
  repositoryId: z.string().min(1).max(512),
  canonicalRepositoryId: z.string().min(1).max(512).optional(),
  endpointId: Identifier,
  status: z.enum(["ready", "not_git", "unavailable"]),
  branch: z.string().max(512).optional(),
  revision: z.string().max(64).optional(),
  dirty: z.boolean().optional(),
  commitCount: z.number().int().nonnegative().optional(),
  commits: z.array(z.object({
    sha: z.string().regex(/^[a-f0-9]{40,64}$/),
    subject: z.string().max(240),
    author: z.string().max(160),
    committedAt: z.number().nonnegative(),
  }).strict()).max(8),
  contributors: z.array(z.object({name:z.string().max(160),commits:z.number().int().nonnegative()}).strict()).max(12),
  contributorCount: z.number().int().nonnegative().optional(),
  observedAt: z.number().nonnegative(),
}).strict();
export type ProjectRepositoryDetails = z.infer<typeof ProjectRepositoryDetails>;
