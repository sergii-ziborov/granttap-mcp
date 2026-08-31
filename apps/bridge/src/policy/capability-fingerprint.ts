import { basename } from "node:path";
import type {
  CapabilityFingerprint,
  CapabilityKind,
} from "../engine/engine-policy-types";

export type ActionFingerprintInput = {
  provider: "claude" | "codex" | "cursor" | "grok";
  toolName?: string;
  toolInput?: Record<string, unknown>;
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
  if (isShellTool(normalized)) return shellFingerprint(input.provider, input.toolInput);
  return fingerprint("agent", tool, input.provider, "provider-tool");
}

function shellFingerprint(
  provider: ActionFingerprintInput["provider"],
  toolInput?: Record<string, unknown>,
): CapabilityFingerprint {
  const command = commandText(toolInput?.command);
  if (isDeploy(command)) return fingerprint("deploy", "Deploy", provider, "shell-command");
  if (isNetwork(command)) return fingerprint("network", "Network command", provider, "shell-command");
  const script = scriptName(command);
  if (script) return fingerprint("script", script, provider, "shell-script");
  return fingerprint("shell", "Shell", provider, "provider-shell");
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

function isDeploy(command: string): boolean {
  return /\b(?:git\s+push|npm\s+publish|deploy|release)\b/i.test(command);
}

function isNetwork(command: string): boolean {
  return /\b(?:curl|wget|ssh|scp|rsync)\b/i.test(command);
}

function scriptName(command: string): string | undefined {
  const token = command.trim().split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "");
  if (!token || !/\.(?:sh|bash|zsh|py|js|mjs|cjs|ts)$/i.test(token)) return undefined;
  return bounded(basename(token), 160) ?? undefined;
}

function bounded(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || clean.length > maximum || /[\u0000-\u001f\u007f]/.test(clean)) return null;
  return clean;
}
