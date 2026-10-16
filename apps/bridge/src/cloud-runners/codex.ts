import type { CloudReference } from "./claude";

const TASK = /^task_[a-z]_[A-Za-z0-9]{1,120}$/;

/** `codex cloud exec` submits one task to an environment without the TUI. */
export function codexCloudArgs(input: { prompt: string; environment: string; branch?: string }): string[] {
  return ["cloud", "exec", "--env", input.environment,
    ...(input.branch ? ["--branch", input.branch] : []), input.prompt];
}

/** The task link or id Codex printed; nothing else counts as a submitted task. */
export function parseCodexCloud(stdout: string): CloudReference | undefined {
  const link = /(https:\/\/[^\s/]+\/codex\/tasks\/([A-Za-z0-9_-]{1,128}))/.exec(stdout);
  if (link && TASK.test(link[2]!)) return { reference: link[2]!, url: link[1]! };
  const id = /\b(task_[a-z]_[A-Za-z0-9]{1,120})\b/.exec(stdout)?.[1];
  return id ? { reference: id } : undefined;
}

/** `owner/repo` and `repo`, lower-cased, from any GitHub-style repository id. */
function repositoryNames(repository: string): string[] {
  const path = repository.trim().replace(/\.git$/i, "").replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, "").replace(/^[^/:]+[/:]/, "").toLowerCase();
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? [parts.slice(-2).join("/"), parts.at(-1)!] : parts;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(value) ? value
    : (value as { tasks?: unknown; items?: unknown; data?: unknown } | null)?.tasks
      ?? (value as { items?: unknown } | null)?.items ?? (value as { data?: unknown } | null)?.data;
  return Array.isArray(list) ? list.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
}

/**
 * The environment this repository's recent Codex Cloud tasks ran in, when
 * exactly one is labelled with the repository's name. Nothing is guessed.
 */
export function environmentForRepository(listJson: string, repository: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(listJson); } catch { return undefined; }
  const names = new Set(repositoryNames(repository));
  const matches = new Set<string>();
  for (const row of rows(parsed)) {
    const label = row.environment_label ?? row.environmentLabel;
    if (typeof label !== "string" || !names.has(label.trim().toLowerCase())) continue;
    const id = row.environment_id ?? row.environmentId;
    matches.add(typeof id === "string" && id.trim() ? id.trim() : label.trim());
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
