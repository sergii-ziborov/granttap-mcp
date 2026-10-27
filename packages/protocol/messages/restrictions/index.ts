import { z } from 'zod';
import { Identifier, Label } from '../mesh/endpoint';

export const ProjectRestrictionKind = z.enum([
  'max_file_lines', 'max_function_lines', 'max_file_bytes', 'custom',
]);
export type ProjectRestrictionKind = z.infer<typeof ProjectRestrictionKind>;
export const ProjectRestrictionScope = z.enum(['project', 'project_and_repo', 'sync_from_repo']);
export type ProjectRestrictionScope = z.infer<typeof ProjectRestrictionScope>;
export const ProjectRestrictionRule = z.object({
  ruleId: Identifier, kind: ProjectRestrictionKind,
  limit: z.number().int().positive().max(1_000_000).optional(),
  name: Label.optional(),
  paths: z.array(z.string().trim().min(1).max(256)).max(16).optional(),
  effect: z.enum(['ask', 'deny']).default('deny'),
}).strict().superRefine((value, ctx) => {
  if (value.kind !== 'custom' && value.limit == null) {
    ctx.addIssue({ code: 'custom', path: ['limit'], message: 'limit required' });
  }
  if (value.kind === 'custom' && !value.name) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: 'custom needs a name' });
  }
});
export type ProjectRestrictionRule = z.infer<typeof ProjectRestrictionRule>;

/** Agent preferences, never a claim that a semantic rule has a machine checker. */
export const ProjectRestrictionGuidance = z.object({
  principles: z.array(z.enum([
    'single_responsibility', 'small_interfaces', 'composition', 'dependency_inversion',
    'behavior_tests', 'clear_names', 'explicit_errors', 'no_duplication',
  ])).max(8).refine(items => new Set(items).size === items.length, 'duplicate principle'),
  architecture: z.enum([
    'preserve', 'feature_modules', 'layered', 'clean', 'hexagonal', 'modular_monolith', 'mvvm',
  ]),
  classLineTarget: z.number().int().positive().max(1_000_000).optional(),
  parameterTarget: z.number().int().positive().max(1_000).optional(),
  markdown: z.string().refine(text => !text.includes('\0') && new TextEncoder().encode(text).length <= 12_000,
    'Markdown must fit 12000 UTF-8 bytes and contain no NUL'),
}).strict();
export type ProjectRestrictionGuidance = z.infer<typeof ProjectRestrictionGuidance>;

export const ProjectRestrictionSet = z.object({
  projectId: Identifier,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scope: ProjectRestrictionScope,
  repositoryId: z.string().trim().min(1).max(512).optional(),
  rules: z.array(ProjectRestrictionRule).max(32),
  source: z.enum(['phone', 'repo']).default('phone'),
  guidance: ProjectRestrictionGuidance.optional(),
}).strict();
export type ProjectRestrictionSet = z.infer<typeof ProjectRestrictionSet>;
