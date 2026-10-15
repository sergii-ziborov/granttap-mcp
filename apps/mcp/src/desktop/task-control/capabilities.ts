import { join } from "node:path";
import { z } from "zod";
import { configDir, loadRuntimeConfig } from "../../../../bridge/src/config";
import { mcpServersForProvider, workspaceSkills } from "../../../../bridge/src/capabilities";
import { observedComputerId } from "../../../../bridge/src/mesh/identity/computer";
import { localTaskSession } from "../delivery/task-scope";

const Query = z.object({ project_id: z.string(), task_id: z.string(), session_id: z.string(),
  operation: z.literal("desktop.task_capabilities").optional() }).strict();

/** Called in the parsing worker: native CLI discovery must not delay Stop. */
export function desktopTaskCapabilities(input: unknown,
  storePath = join(configDir(), "project-mesh.json"), endpointId = observedComputerId()) {
  const parsed = Query.safeParse(input);
  if (!parsed.success) return undefined;
  const session = localTaskSession(parsed.data, storePath, endpointId);
  if (!session) return undefined;
  const runtime = loadRuntimeConfig();
  const mcpDisabled = runtime.sessionMcpDisabled[session.sessionId] ?? [];
  const skillsDisabled = runtime.sessionSkillsDisabled[session.sessionId] ?? [];
  return { operation: "desktop.task_capabilities", project_id: session.projectId,
    task_id: session.taskId, session_id: session.sessionId,
    mcp_servers: mcpServersForProvider(session.agent, session.cwd).slice(0, 64).map(server => ({
      ...server, allowed: server.allowed && !mcpDisabled.includes(server.name),
    })),
    skills: workspaceSkills(session.cwd).slice(0, 64).map(skill => ({
      ...skill, allowed: !skillsDisabled.includes(skill.name),
    })), shell_allowed: !runtime.sessionShellDisabled.includes(session.sessionId) };
}
