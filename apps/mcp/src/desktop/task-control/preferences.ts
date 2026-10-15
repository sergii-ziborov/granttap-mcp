import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { AgentAccess, AutoAcceptLevel, CapabilityName } from "../../../../../packages/protocol/schema";
import { autoAcceptLevelFor, configDir, loadRuntimeConfig, saveRuntimeConfig,
  setSessionMcpAllowed, setSessionSkillAllowed, setSessionShellAllowed } from "../../../../bridge/src/config";
import { applyConfigSet, currentConfigRevision } from "../../../../bridge/src/config/commands";
import { currentInstanceEpoch } from "../../../../bridge/src/host/instance-epoch";
import { observedComputerId } from "../../../../bridge/src/mesh/identity/computer";
import { localTaskSession } from "../delivery/task-scope";

const Toggle = z.object({ name: CapabilityName, allowed: z.boolean() }).strict();
const Query = z.object({ project_id: z.string(), task_id: z.string(), session_id: z.string(),
  access_level: AgentAccess.optional(), excluded: z.boolean().optional(),
  auto_accept_level: AutoAcceptLevel.optional(), authorize_project_ask: z.boolean().optional(),
  clear_auto_accept: z.boolean().optional(),
  expected_policy_revision: z.number().int().nonnegative().optional(), approval_request_id: z.string().max(180).optional(),
  mcp: Toggle.optional(), skill: Toggle.optional(), shell_allowed: z.boolean().optional(),
}).strict();

export function desktopTaskPreferences(input: unknown, options: { storePath?: string; endpointId?: string } = {}) {
  const parsed = Query.safeParse(input);
  if (!parsed.success) return undefined;
  const q = parsed.data;
  const session = localTaskSession(q, options.storePath ?? join(configDir(), "project-mesh.json"),
    options.endpointId ?? observedComputerId());
  if (!session || q.access_level && session.agent !== "codex"
    || q.excluded !== undefined && q.auto_accept_level !== undefined
    || q.clear_auto_accept && (q.excluded !== undefined || q.auto_accept_level !== undefined)) return undefined;
  if (q.excluded !== undefined || q.auto_accept_level !== undefined || q.clear_auto_accept) {
    const result = applyConfigSet({ type: "config.set", createdAt: Date.now(), operationId: randomUUID(),
      baseRevision: currentConfigRevision(), instanceEpoch: currentInstanceEpoch(), expiresAt: Date.now() + 60_000,
      ...(q.excluded === undefined ? {} : q.excluded ? { excludeSession: session.sessionId } : { includeSession: session.sessionId }),
      ...(q.auto_accept_level === undefined ? {} : { includeSession: session.sessionId,
        autoAcceptSession: { sessionId: session.sessionId, level: q.auto_accept_level,
          authorizeProjectAsk: q.authorize_project_ask, expectedPolicyRevision: q.expected_policy_revision,
          approvalRequestId: q.approval_request_id } }),
      ...(q.clear_auto_accept ? { autoAcceptSession: { sessionId: session.sessionId, level: null } } : {}),
    });
    if (result.kind === "rejected") return { operation: "desktop.task_preferences", accepted: false,
      error: "The computer did not apply this rule. Refresh the connection and try again." };
  }
  if (q.access_level) {
    const runtime = loadRuntimeConfig();
    runtime.sessionAccess[session.sessionId] = q.access_level;
    saveRuntimeConfig(runtime);
  }
  if (q.mcp) setSessionMcpAllowed(session.sessionId, q.mcp.name, q.mcp.allowed);
  if (q.skill) setSessionSkillAllowed(session.sessionId, q.skill.name, q.skill.allowed);
  if (q.shell_allowed !== undefined) setSessionShellAllowed(session.sessionId, q.shell_allowed);
  const runtime = loadRuntimeConfig();
  return { operation: "desktop.task_preferences", accepted: true, session_id: session.sessionId, generated_at: Date.now(),
    paused: runtime.pausedSessions.includes(session.sessionId), access_level: runtime.sessionAccess[session.sessionId],
    excluded: runtime.excludedSessions.includes(session.sessionId), level: autoAcceptLevelFor(session.sessionId, session.projectId),
    shell_allowed: !runtime.sessionShellDisabled.includes(session.sessionId),
    mcp_disabled: runtime.sessionMcpDisabled[session.sessionId] ?? [], skills_disabled: runtime.sessionSkillsDisabled[session.sessionId] ?? [] };
}
