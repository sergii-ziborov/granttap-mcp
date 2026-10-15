import type {
  ConfigSet,
  HostGrant,
  SessionAccessSet,
  SessionCompact,
  SessionControl,
  SessionMcpSet,
  SessionShellSet,
  SessionSkillSet,
  SessionSubscription,
} from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import {
  applyConfigSet,
  loadConfigCommandState,
} from "../../config/commands";
import {
  loadRuntimeConfig,
  saveRuntimeConfig,
  setSessionMcpAllowed,
  setSessionShellAllowed,
  setSessionSkillAllowed,
} from "../../config";
import { compactTaskSession, controlTaskSession } from "../../task-control";
import { acceptInstanceEpoch } from "../../host/instance-epoch";
import { applyHostGrant } from "../../mesh/runtime/execution-policy";
import { computerId } from "../../mesh/identity/computer";
import { sendSessionPayload } from "../../host/session-keys";

export function handleAccessSet(message: SessionAccessSet): void {
  const runtime = loadRuntimeConfig();
  runtime.sessionAccess[message.sessionId] = message.accessLevel;
  saveRuntimeConfig(runtime);
}

export function handleMcpSet(message: SessionMcpSet): void {
  setSessionMcpAllowed(message.sessionId, message.serverName, message.allowed);
}

export function handleSkillSet(message: SessionSkillSet): void {
  setSessionSkillAllowed(message.sessionId, message.skillName, message.allowed);
}

export function handleShellSet(message: SessionShellSet): void {
  setSessionShellAllowed(message.sessionId, message.allowed);
}

export { RESUME_PROMPT } from "../../task-control";

/** Phone and local desktop actions share the same computer-enforced implementation. */
export async function handleSessionControl(client: RelayClient, message: SessionControl,
  afterContinue: () => void = () => {}): Promise<void> {
  await controlTaskSession(message, async (ok, text) => {
    await sendSessionPayload(client, { type: "session.control.result", sessionId: message.sessionId,
      action: message.action, ok, message: text.slice(0, 1_000), createdAt: Date.now(),
    }, message.sessionId, "phone", { ttlMs: 15 * 60_000 });
  }, afterContinue);
}

export async function handleCompact(client: RelayClient, message: SessionCompact): Promise<void> {
  await compactTaskSession(message.sessionId, async (ok, text) => {
    await sendSessionPayload(client, { type: "session.compact.result", sessionId: message.sessionId,
      ok, message: text, createdAt: Date.now(),
    }, message.sessionId, "phone", { ttlMs: 15 * 60_000 });
  });
}

/**
 * Elect one monitor across all GrantTap MCP processes on this machine. The
 * lock records the owning pid and is reclaimed automatically after a crash;
 * non-leaders retry on each publish tick and on incoming relay traffic.
 */

/**
 * Report whether this actually changed what the monitor is watching.
 *
 * The phone re-sends `session.subscribe` every few seconds while a chat is
 * open. Treating each repeat as news turned one heartbeat into a full provider
 * rescan, so only a real change is worth republishing the catalog for.
 */
export function handleSubscription(subscriptions: Set<string>, message: SessionSubscription): boolean {
  const before = subscriptions.size;
  if (message.active) subscriptions.add(message.sessionId);
  else subscriptions.delete(message.sessionId);
  return subscriptions.size !== before;
}

export function handleConfigSet(message: ConfigSet) {
  return applyConfigSet(message);
}

export function handleHostGrant(message: HostGrant): void {
  if (!acceptInstanceEpoch(message.instanceEpoch, loadConfigCommandState().requireFreshCommands)) {
    return;
  }
  applyHostGrant(message.projectId, message.grant, message.revision, computerId());
}
