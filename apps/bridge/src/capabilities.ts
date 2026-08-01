import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpServerInfo, SessionInfo, SkillInfo } from "../../../packages/protocol/schema";

type CodexMcpRow = {
  name?: unknown;
  enabled?: unknown;
  auth_status?: unknown;
};

let codexCache: { at: number; rows: CodexMcpRow[] } | undefined;
const CACHE_MS = 30_000;

function codexMcpRows(): CodexMcpRow[] {
  if (codexCache && Date.now() - codexCache.at < CACHE_MS) return codexCache.rows;
  try {
    const command = process.env.GRANTTAP_CODEX_BIN ?? process.env.NODVOX_CODEX_BIN ?? "codex";
    const output = execFileSync(command, ["mcp", "list", "--json"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output);
    const rows = Array.isArray(parsed) ? parsed : [];
    codexCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return codexCache?.rows ?? [];
  }
}

function jsonFile(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function ancestors(cwd: string): string[] {
  const out: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    out.push(current);
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function claudeMcpNames(cwd: string | undefined): string[] {
  const config = jsonFile(join(homedir(), ".claude.json"));
  const names = new Set(Object.keys(config.mcpServers ?? {}));
  if (cwd) {
    for (const dir of ancestors(cwd)) {
      const project = jsonFile(join(dir, ".mcp.json"));
      for (const name of Object.keys(project.mcpServers ?? {})) names.add(name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function mcpServersForSession(session: SessionInfo, disabled: string[]): McpServerInfo[] {
  const denied = new Set(disabled);
  if (session.agent === "codex") {
    return codexMcpRows()
      .filter((row) => typeof row.name === "string")
      .map((row) => {
        const name = String(row.name);
        const configuredEnabled = row.enabled !== false;
        return {
          name,
          configuredEnabled,
          allowed: configuredEnabled && !denied.has(name),
          authStatus: typeof row.auth_status === "string" ? row.auth_status : undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return claudeMcpNames(session.cwd).map((name) => ({
    name,
    configuredEnabled: true,
    allowed: !denied.has(name),
  }));
}

function frontmatter(path: string): SkillInfo | undefined {
  try {
    const body = readFileSync(path, "utf8");
    if (!body.startsWith("---")) return undefined;
    const end = body.indexOf("\n---", 3);
    if (end < 0) return undefined;
    const header = body.slice(3, end);
    const name = header.match(/^name:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    if (!name) return undefined;
    const description = header.match(/^description:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    return { name, description };
  } catch {
    return undefined;
  }
}

function skillsIn(root: string): SkillInfo[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skill = frontmatter(join(dir, "SKILL.md"));
    if (skill) out.push(skill);
  }
  return out;
}

/** Repository-scoped skills only: these are the ones connected to the task's folder. */
export function workspaceSkills(cwd: string | undefined): SkillInfo[] {
  if (!cwd) return [];
  const found = new Map<string, SkillInfo>();
  for (const dir of ancestors(cwd)) {
    for (const root of [join(dir, ".agents", "skills"), join(dir, ".claude", "skills")]) {
      for (const skill of skillsIn(root)) if (!found.has(skill.name)) found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
