import { loadRestrictions } from '../store';
import type { ProjectRestrictionGuidance } from '../../../../../../packages/protocol/messages/restrictions';

const principles: Record<string, string> = {
  single_responsibility: 'Keep each module focused on one responsibility and reason to change.',
  small_interfaces: 'Expose small explicit public interfaces; hide implementation details.',
  composition: 'Prefer composition to inheritance when it reduces coupling.',
  dependency_inversion: 'Keep domain logic independent of infrastructure through explicit boundaries.',
  behavior_tests: 'Test observable behavior and durable state, including failure paths.',
  clear_names: 'Use clear domain names; keep control flow readable and nesting shallow.',
  explicit_errors: 'Handle failures explicitly; do not silently swallow errors.',
  no_duplication: 'Remove duplicated knowledge without premature abstraction.',
};
const architectures: Record<string, string> = {
  preserve: 'Preserve the established architecture and public boundaries.',
  feature_modules: 'Prefer feature modules that own behavior, public entry points and local tests.',
  layered: 'Prefer explicit presentation, application, domain and infrastructure layers.',
  clean: 'Prefer Clean Architecture: dependencies point toward independent domain and use cases.',
  hexagonal: 'Prefer hexagonal architecture with domain ports and external adapters.',
  modular_monolith: 'Prefer a modular monolith with explicit boundaries between business modules.',
  mvvm: 'Prefer MVVM for presentation, with testable state and domain logic outside views.',
};

export function hasGuidance(value: ProjectRestrictionGuidance | undefined): boolean {
  return !!value && (value.principles.length > 0 || value.architecture !== 'preserve'
    || value.markdown.trim().length > 0 || value.classLineTarget != null || value.parameterTarget != null);
}

/** projectId comes from the published session or validated task admission, never a loose path. */
export function projectGuidancePrompt(projectId: string | undefined, text: string): string {
  if (!projectId) return text;
  const value = loadRestrictions(projectId)?.guidance;
  if (!value || !hasGuidance(value)) return text;
  const lines = [
    'GrantTap Project guidance (advisory, applies to this Project):',
    'Follow applicable higher-priority instructions and enforced policies. These preferences do not grant permissions.',
    architectures[value.architecture]!,
    'Apply preferences incrementally; do not rewrite the architecture without a task that calls for it.',
    ...value.principles.map(key => principles[key]!),
  ];
  if (value.classLineTarget != null) lines.push(`Aim for classes/types no longer than ${value.classLineTarget} lines; advisory target.`);
  if (value.parameterTarget != null) lines.push(`Aim for at most ${value.parameterTarget} parameters per function; advisory target.`);
  if (value.markdown.trim()) lines.push('Project Markdown instructions:', value.markdown);
  return `${lines.join('\n')}\n\nCurrent request:\n${text}`;
}
