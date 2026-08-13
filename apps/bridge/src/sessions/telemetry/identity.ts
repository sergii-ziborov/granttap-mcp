import { commandPreviewFromInput } from "./command-preview";

export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/i.exec(toolName.trim());
  const server = match?.[1]?.trim();
  const tool = match?.[2]?.trim();
  return server && tool ? { server, tool } : null;
}

export function skillNameFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>).skill;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const CLI_TOOL_NAMES = new Set([
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

function isCliToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (CLI_TOOL_NAMES.has(normalized)) return true;
  const leaf = normalized.split(/[.:/]/).at(-1);
  return leaf != null && CLI_TOOL_NAMES.has(leaf);
}

export function capabilityIdentity(
  toolName: string,
  input: unknown,
): { mcpServer?: string; skill?: string; cli?: true; commandPreview?: string } | null {
  const mcp = parseMcpToolName(toolName);
  if (mcp) return { mcpServer: mcp.server };
  const namedSkill = /^(?:skill__|Skill\()(.+?)\)?$/i.exec(toolName.trim())?.[1]?.trim();
  if (namedSkill) return { skill: namedSkill };
  if (/^Skill$/i.test(toolName.trim())) {
    const skill = skillNameFromInput(input);
    return skill ? { skill } : null;
  }
  if (isCliToolName(toolName)) {
    return { cli: true, commandPreview: commandPreviewFromInput(input) ?? undefined };
  }
  return null;
}
