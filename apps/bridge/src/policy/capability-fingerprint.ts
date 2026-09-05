import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, normalize, resolve } from "node:path";
import type {
  CapabilityFingerprint,
  CapabilityKind,
} from "../engine/engine-policy-types";
import { commandName } from "../sessions/telemetry";

export type ActionFingerprintInput = {
  provider: "claude" | "codex" | "cursor" | "grok";
  cwd?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
};

export type McpFingerprintEvidence = {
  serverName?: string | null;
  transport?: string;
  configHash?: string;
};

const SHELL_TOOLS = new Set([
  "bash", "shell", "shell_command", "terminal", "exec_command", "execute_command",
  "local_shell_call", "run_command", "run_in_terminal", "run_terminal_cmd",
]);
const WRITE_TOOLS = new Set(["edit", "write", "notebookedit", "multiedit"]);
const NETWORK_TOOLS = new Set(["webfetch", "websearch"]);
const AGENT_TOOLS = new Set(["agent", "task"]);

export function capabilityFingerprint(input: ActionFingerprintInput): CapabilityFingerprint {
  const tool = bounded(input.toolName, 240) ?? "Unknown tool";
  const normalized = tool.toLowerCase();
  const mcp = /^mcp__(.+?)__(.+)$/i.exec(tool)?.[1];
  if (mcp) return fingerprint("mcp", bounded(mcp, 160) ?? "Unknown MCP", input.provider, "mcp");

  const skill = skillName(tool, input.toolInput);
  if (skill) return fingerprint("skill", skill, input.provider, "skill");
  if (WRITE_TOOLS.has(normalized)) {
    return fingerprint("file_write", tool, input.provider, "provider-tool");
  }
  if (NETWORK_TOOLS.has(normalized)) {
    return fingerprint("network", tool, input.provider, "provider-tool");
  }
  if (AGENT_TOOLS.has(normalized)) {
    return fingerprint("agent", tool, input.provider, "provider-tool");
  }
  if (isShellTool(normalized)) return shellFingerprint(input.provider, input.toolInput, input.cwd);
  return fingerprint("agent", tool, input.provider, "provider-tool");
}

export function mcpCapabilityFingerprint(
  provider: ActionFingerprintInput["provider"],
  evidence: McpFingerprintEvidence,
): CapabilityFingerprint {
  const displayName = bounded(evidence.serverName, 160) ?? "Unknown MCP";
  const transport = bounded(evidence.transport, 160) ?? undefined;
  const configHash = sha256Evidence(evidence.configHash);
  const confidence = displayName === "Unknown MCP"
    ? "unknown"
    : configHash ? "exact" : transport ? "strong" : "name_only";
  return {
    kind: "mcp",
    display_name: displayName,
    provider,
    origin: "provider-mcp-config",
    ...(transport ? { transport } : {}),
    ...(configHash ? { config_hash: configHash } : {}),
    confidence,
  };
}

function shellFingerprint(
  provider: ActionFingerprintInput["provider"],
  toolInput?: Record<string, unknown>,
  cwd?: string,
): CapabilityFingerprint {
  const command = commandText(toolInput?.command);
  const script = scriptIdentity(command, cwd);
  if (script?.plugin) {
    return {
      ...fingerprint("skill", script.plugin, provider, "shell-plugin"),
      ...(script.pathHash ? { executable_path_hash: script.pathHash, confidence: "exact" } : {}),
    };
  }
  // A commit or a pull request that carries a co-authorship or "generated
  // with" trailer is its own thing to decide about: a Project that wants its
  // history authored by people can forbid the trailer without forbidding git.
  if (carriesCoAuthorship(command)) {
    return fingerprint("shell", CO_AUTHORSHIP, provider, "shell-command");
  }
  // Named by the phrase that made it a deploy or a network call — "git push",
  // "curl" — so a Project can forbid pushing without forbidding every release.
  const deploy = deployPhrase(command);
  if (deploy) return fingerprint("deploy", deploy, provider, "shell-command");
  const network = networkCommand(command);
  if (network) return fingerprint("network", network, provider, "shell-command");
  if (script) {
    return {
      ...fingerprint("script", script.name, provider, "shell-script"),
      ...(script.pathHash ? { executable_path_hash: script.pathHash, confidence: "exact" } : {}),
    };
  }
  // Named by the command, so a Project can say "git: allow, rm: ask" instead
  // of only "shell: ask". A line with no command word stays plain shell.
  return fingerprint("shell", bounded(commandName(command), 160) ?? "Shell", provider, "provider-shell");
}

function fingerprint(
  kind: CapabilityKind,
  displayName: string,
  provider: ActionFingerprintInput["provider"],
  origin: string,
): CapabilityFingerprint {
  return {
    kind,
    display_name: displayName,
    provider,
    origin,
    confidence: displayName.startsWith("Unknown") ? "unknown" : "name_only",
  };
}

function skillName(tool: string, input?: Record<string, unknown>): string | undefined {
  const inline = /^(?:skill__|Skill\()(.+?)\)?$/i.exec(tool)?.[1];
  if (inline) return bounded(inline, 160) ?? undefined;
  if (!/^skill$/i.test(tool)) return undefined;
  return bounded(input?.skill, 160) ?? undefined;
}

function isShellTool(tool: string): boolean {
  if (SHELL_TOOLS.has(tool)) return true;
  const leaf = tool.split(/[.:/]/).at(-1);
  return leaf != null && SHELL_TOOLS.has(leaf);
}

function commandText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 4_096);
  if (Array.isArray(value)) return value.map(String).join(" ").slice(0, 4_096);
  return "";
}

/** The name a co-authored commit or PR is governed under; the phone offers it as a row. */
export const CO_AUTHORSHIP = "co-authorship";

const AUTHORSHIP_COMMANDS = /\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(?:commit|merge|rebase|cherry-pick|am)\b|\bgh\s+pr\s+(?:create|edit|merge)\b/i;
const AUTHORSHIP_TRAILERS = /co-authored-by\s*:|generated\s+with\s+\[?claude|noreply@anthropic\.com|🤖\s*generated/i;

/** True when a commit or PR command writes a co-author or "generated with" trailer. */
export function carriesCoAuthorship(command: string): boolean {
  return AUTHORSHIP_COMMANDS.test(command) && AUTHORSHIP_TRAILERS.test(command);
}

export function deployPhrase(command: string): string | undefined {
  const match = /\b(git\s+push|npm\s+publish|deploy|release)\b/i.exec(command);
  return match ? match[1]!.toLowerCase().replace(/\s+/g, " ") : undefined;
}

export function networkCommand(command: string): string | undefined {
  const match = /\b(curl|wget|ssh|scp|rsync)\b/i.exec(command);
  return match ? match[1]!.toLowerCase() : undefined;
}

function scriptIdentity(
  command: string,
  cwd?: string,
): { name: string; plugin?: string; pathHash?: string } | undefined {
  const words = commandWords(command);
  const executable = basename(words[0] ?? "").toLowerCase();
  const interpreters = new Set(["bash", "sh", "zsh", "python", "python3", "node", "tsx"]);
  const pluginToken = words.find((word) => {
    const token = cleanScriptToken(word);
    return isScriptToken(token) && pluginName(pathSegments(token)) != null;
  });
  const selected = pluginToken ?? (interpreters.has(executable)
    ? words.slice(1).find((word) => !word.startsWith("-"))
    : words[0]);
  const token = cleanScriptToken(selected ?? "");
  if (!isScriptToken(token)) return undefined;
  const path = resolvedPath(token, cwd);
  const segments = pathSegments(token);
  const plugin = pluginName(segments);
  return {
    name: bounded(basename(token), 160) ?? "Unknown script",
    ...(plugin ? { plugin } : {}),
    ...(path ? { pathHash: createHash("sha256").update(path).digest("hex") } : {}),
  };
}

function cleanScriptToken(value: string): string {
  return value.replace(/^[('"`]+|[)'"`;|&]+$/g, "");
}

function isScriptToken(value: string): boolean {
  return /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts)$/i.test(value);
}

function pathSegments(value: string): string[] {
  return normalize(value).split(/[\\/]/).filter(Boolean);
}

function pluginName(segments: string[]): string | undefined {
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!/^(?:plugins?|skills?)$/i.test(segments[index] ?? "")) continue;
    const next = segments[index + 1];
    const candidate = /^(?:cache|marketplaces)$/i.test(next ?? "")
      ? segments[index + 2]
      : next;
    const boundedName = bounded(candidate, 160) ?? undefined;
    if (boundedName && !/^(?:cache|marketplaces)$/i.test(boundedName)) return boundedName;
  }
  return undefined;
}

function commandWords(command: string): string[] {
  return [...command.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)]
    .map((match) => match[0].replace(/^(['"])(.*)\1$/, "$2"))
    .slice(0, 16);
}

function resolvedPath(token: string, cwd?: string): string | undefined {
  const expanded = token.startsWith("~/") ? resolve(homedir(), token.slice(2)) : token;
  if (isAbsolute(expanded)) return normalize(expanded);
  return cwd && isAbsolute(cwd) && token.includes("/") ? resolve(cwd, token) : undefined;
}

function sha256Evidence(value: unknown): string | undefined {
  const clean = bounded(value, 64);
  return clean && /^[0-9a-f]{64}$/i.test(clean) ? clean.toLowerCase() : undefined;
}

function bounded(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || clean.length > maximum || /[\u0000-\u001f\u007f]/.test(clean)) return null;
  return clean;
}
