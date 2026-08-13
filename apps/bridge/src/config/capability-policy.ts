import {
  boundedIdentifier,
  capabilityName,
  capabilitySessionId,
  loadRuntimeConfig,
  saveRuntimeConfig,
} from "./runtime";

export function setSessionMcpAllowed(
  rawSessionId: string,
  rawServerName: string,
  allowed: boolean,
): void {
  const sessionId = capabilitySessionId(rawSessionId);
  const serverName = capabilityName(rawServerName);
  if (!sessionId || !serverName) throw new TypeError("invalid session MCP toggle");
  const runtime = loadRuntimeConfig();
  const denied = new Set(runtime.sessionMcpDisabled[sessionId] ?? []);
  if (allowed) denied.delete(serverName);
  else denied.add(serverName);
  if (denied.size === 0) delete runtime.sessionMcpDisabled[sessionId];
  else runtime.sessionMcpDisabled[sessionId] = [...denied].sort();
  saveRuntimeConfig(runtime);
}

export function setSessionSkillAllowed(
  rawSessionId: string,
  rawSkillName: string,
  allowed: boolean,
): void {
  const sessionId = capabilitySessionId(rawSessionId);
  const skillName = capabilityName(rawSkillName);
  if (!sessionId || !skillName) throw new TypeError("invalid session skill toggle");
  const runtime = loadRuntimeConfig();
  const denied = new Set(runtime.sessionSkillsDisabled[sessionId] ?? []);
  if (allowed) denied.delete(skillName);
  else denied.add(skillName);
  if (denied.size === 0) delete runtime.sessionSkillsDisabled[sessionId];
  else runtime.sessionSkillsDisabled[sessionId] = [...denied].sort();
  saveRuntimeConfig(runtime);
}

export function setSessionShellAllowed(rawSessionId: string, allowed: boolean): void {
  const sessionId = capabilitySessionId(rawSessionId);
  if (!sessionId) throw new TypeError("invalid session shell toggle");
  const runtime = loadRuntimeConfig();
  const denied = new Set(runtime.sessionShellDisabled);
  if (allowed) denied.delete(sessionId);
  else denied.add(sessionId);
  runtime.sessionShellDisabled = [...denied].sort();
  saveRuntimeConfig(runtime);
}

export type SessionCapabilityBlock = {
  kind: "mcp" | "skill" | "cli";
  name: string;
  reason: string;
};

function mcpBlock(server: string): SessionCapabilityBlock {
  return {
    kind: "mcp",
    name: server,
    reason: `GrantTap disabled MCP server “${server}” for this chat`,
  };
}

function skillBlock(skill: string): SessionCapabilityBlock {
  return {
    kind: "skill",
    name: skill,
    reason: `GrantTap disabled skill “${skill}” for this chat`,
  };
}

export function blockedSessionMcpServer(
  rawSessionId: string | null | undefined,
  rawServerName: string | null | undefined,
): SessionCapabilityBlock | null {
  const sessionId = capabilitySessionId(rawSessionId);
  const server = capabilityName(rawServerName);
  if (!sessionId || !server) return null;
  const runtime = loadRuntimeConfig();
  return (runtime.sessionMcpDisabled[sessionId] ?? []).includes(server)
    ? mcpBlock(server)
    : null;
}

export function blockedSessionSkill(
  rawSessionId: string | null | undefined,
  rawSkillName: string | null | undefined,
): SessionCapabilityBlock | null {
  const sessionId = capabilitySessionId(rawSessionId);
  const skill = capabilityName(rawSkillName);
  if (!sessionId || !skill) return null;
  const runtime = loadRuntimeConfig();
  return (runtime.sessionSkillsDisabled[sessionId] ?? []).includes(skill)
    ? skillBlock(skill)
    : null;
}

const SESSION_CLI_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "powershell",
  "terminal",
  "exec_command",
  "execute_command",
  "local_shell_call",
  "run_command",
  "run_in_terminal",
  "run_terminal_cmd",
  "shell_command",
]);

function isSessionCliTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (SESSION_CLI_TOOL_NAMES.has(normalized)) return true;
  const leaf = normalized.split(/[.:/]/).at(-1);
  return leaf != null && SESSION_CLI_TOOL_NAMES.has(leaf);
}

function mcpServerFromTool(toolName: string): string | null {
  return capabilityName(/^mcp__(.+?)__(.+)$/i.exec(toolName.trim())?.[1]);
}

function skillFromTool(toolName: string, input: unknown): string | null {
  const named = capabilityName(/^(?:skill__|Skill\()(.+?)\)?$/i.exec(toolName.trim())?.[1]);
  if (named) return named;
  if (!/^Skill$/i.test(toolName.trim()) || !input || typeof input !== "object") return null;
  return capabilityName((input as Record<string, unknown>).skill);
}

export function blockedSessionCapability(
  rawSessionId: string | null | undefined,
  rawToolName: string | null | undefined,
  toolInput?: unknown,
): SessionCapabilityBlock | null {
  const sessionId = capabilitySessionId(rawSessionId);
  const toolName = boundedIdentifier(rawToolName, 240);
  if (!sessionId || !toolName) return null;
  const runtime = loadRuntimeConfig();

  const server = mcpServerFromTool(toolName);
  if (server && (runtime.sessionMcpDisabled[sessionId] ?? []).includes(server)) {
    return mcpBlock(server);
  }
  const skill = skillFromTool(toolName, toolInput);
  if (skill && (runtime.sessionSkillsDisabled[sessionId] ?? []).includes(skill)) {
    return skillBlock(skill);
  }
  if (isSessionCliTool(toolName) && runtime.sessionShellDisabled.includes(sessionId)) {
    return {
      kind: "cli",
      name: "CLI",
      reason: "GrantTap disabled CLI/shell for this chat",
    };
  }
  return null;
}
