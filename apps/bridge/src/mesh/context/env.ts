import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectEnvironment, ProjectEnvVar } from "../../../../../packages/protocol/schema";
import { ProjectEnvironment as EnvironmentSchema } from "../../../../../packages/protocol/schema";
import { configDir } from "../../config/runtime/paths";
import { writePrivateFile } from "../../config/access/write-private";

type StoreFile = { environments: ProjectEnvironment[] };

const PROTECTED_KEYS = new Set([
  "HOME", "PATH", "SHELL", "USER", "LOGNAME", "TMPDIR", "NODE_OPTIONS",
]);

function protectedRuntimeKey(key: string): boolean {
  return PROTECTED_KEYS.has(key)
    || /^(GRANTTAP_|NODVOX_|XDG_|DYLD_|LD_|OPENAI_|ANTHROPIC_|CODEX_|CLAUDE_|CURSOR_|GROK_)/.test(key);
}

export function assertProjectEnvironmentKeys(environment: ProjectEnvironment | undefined): void {
  const item = environment?.variables.find((variable) => protectedRuntimeKey(variable.key));
  if (item) throw new Error(`invalid Project environment: protected runtime key ${item.key}`);
}

export function projectEnvPath(): string {
  return join(configDir(), "project-env.json");
}

export function repoEnvPath(root: string): string {
  return join(root, ".granttap", "env");
}

function loadAll(): ProjectEnvironment[] {
  try {
    const raw = JSON.parse(readFileSync(projectEnvPath(), "utf8")) as StoreFile;
    return Array.isArray(raw.environments)
      ? raw.environments.flatMap((item) => {
        const parsed = EnvironmentSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
      : [];
  } catch {
    return [];
  }
}

function saveAll(environments: ProjectEnvironment[]): void {
  writePrivateFile(projectEnvPath(), `${JSON.stringify({ environments }, null, 2)}\n`);
}

export function loadEnvironment(projectId: string): ProjectEnvironment | undefined {
  return loadAll().find((item) => item.projectId === projectId);
}

export function mergeEnvironment(
  incoming: ProjectEnvironment,
  previous?: ProjectEnvironment,
): ProjectEnvironment {
  const kept = new Map((previous?.variables ?? []).map((item) => [item.key, item]));
  return {
    ...incoming,
    variables: incoming.variables.map((item) => {
      if (item.value != null) return item;
      const prior = kept.get(item.key);
      if (prior?.value == null) return item;
      // A redacted secret has no value on the wire. Changing only its flag
      // cannot turn the stored secret into a public Project value.
      return { ...item, secret: prior.secret || item.secret, value: prior.value };
    }),
  };
}

export function rememberEnvironment(
  projectId: string,
  environment: ProjectEnvironment | undefined,
  repositoryRoot?: string,
): ProjectEnvironment | undefined {
  const others = loadAll().filter((item) => item.projectId !== projectId);
  if (!environment) {
    saveAll(others);
    return undefined;
  }
  assertProjectEnvironmentKeys(environment);
  const stored = mergeEnvironment({ ...environment, projectId }, loadEnvironment(projectId));
  if (stored.shareNonSecretsWithRepo && repositoryRoot) {
    writeRepoEnv(repositoryRoot, stored.variables);
  }
  saveAll([...others, stored]);
  return stored;
}

/** Snapshot and status never carry secret values — only names. */
export function redactEnvironment(
  environment: ProjectEnvironment | undefined,
): ProjectEnvironment | undefined {
  if (!environment) return undefined;
  return {
    ...environment,
    variables: environment.variables.map((item) => (
      item.secret ? { key: item.key, secret: true } : { key: item.key, secret: false, value: item.value }
    )),
  };
}

export function environmentProcessEnv(
  environment: ProjectEnvironment | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const item of environment?.variables ?? []) {
    if (!protectedRuntimeKey(item.key) && item.value != null && item.value !== "") {
      out[item.key] = item.value;
    }
  }
  return out;
}

export function writeRepoEnv(root: string, variables: ProjectEnvVar[]): void {
  const lines = variables
    .filter((item) => !protectedRuntimeKey(item.key) && !item.secret && item.value != null)
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((item) => `${item.key}=${escapeEnv(item.value ?? "")}`);
  const path = repoEnvPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${["# GrantTap Project environment. Secrets stay on the Mesh, not here.", ...lines].join("\n")}\n`,
    { mode: 0o644 },
  );
}

function escapeEnv(value: string): string {
  if (!/[\s#"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export function environmentSummary(environment: ProjectEnvironment | undefined): string {
  if (!environment || environment.variables.length === 0) return "No variables";
  const secrets = environment.variables.filter((item) => item.secret).length;
  const shared = environment.variables.length - secrets;
  const parts = [
    `${environment.variables.length} variable${environment.variables.length === 1 ? "" : "s"}`,
  ];
  if (secrets) parts.push(`${secrets} secret`);
  if (environment.shareNonSecretsWithRepo && shared) parts.push("shared with the repository");
  return parts.join(" · ");
}

export function envFileExists(root: string): boolean {
  return existsSync(repoEnvPath(root));
}
