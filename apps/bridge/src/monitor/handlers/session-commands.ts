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
  setSessionPaused,
  setSessionShellAllowed,
  setSessionSkillAllowed,
} from "../../config";
import { compactCodexSession } from "../../providers/codex-control";
import { deliverToSession, stopDeliveries } from "../../reply";
import { acceptInstanceEpoch } from "../../host/instance-epoch";
import { applyHostGrant } from "../../mesh/runtime/execution-policy";
import { computerId } from "../../mesh/identity/computer";
import { sendSessionPayload } from "../../host/session-keys";
import { scanSessionHistory, scanSessions } from "../../sessions";
import { DELIVERY_TIMEOUT_MS } from "./receipts";

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

/** What the agent is told when the person lifts the hold and asks it to go on. */
export const RESUME_PROMPT =
  "GrantTap: this chat was resumed from the phone. Continue the work you were doing before the pause; tool calls are allowed again.";

/**
 * Pause or resume one chat.
 *
 * A pause is a hold on tool calls, enforced by the provider hooks on every call
 * the chat makes, plus a stop of any delivery already running for it. The
 * result goes back at once; the continuation a resume asks for runs in the
 * background, so a phone that tapped "resume" does not wait on a whole turn.
 */
export async function handleSessionControl(
  client: RelayClient,
  message: SessionControl,
  afterContinue: () => void = () => {},
): Promise<void> {
  const sessionId = message.sessionId;
  const reply = async (ok: boolean, text: string): Promise<void> => {
    await sendSessionPayload(client, {
      type: "session.control.result",
      sessionId,
      action: message.action,
      ok,
      message: text.slice(0, 1_000),
      createdAt: Date.now(),
    }, sessionId, "phone", { ttlMs: 15 * 60_000 });
  };
  try {
    setSessionPaused(sessionId, message.action === "pause");
  } catch (error) {
    return reply(false, error instanceof Error ? error.message : String(error));
  }
  if (message.action === "pause") {
    const stopped = stopDeliveries(sessionId);
    return reply(true, stopped > 0
      ? `Paused. ${stopped} running turn stopped; every tool call from this chat is refused until you resume.`
      : "Paused: every tool call from this chat is refused until you resume.");
  }
  if (!message.continue) return reply(true, "Resumed: tool calls are allowed again.");
  const session = scanSessions().sessions.find((item) => item.sessionId === sessionId)
    ?? scanSessionHistory().find((item) => item.sessionId === sessionId);
  if (!session) {
    return reply(true, "Resumed. This chat is not on this computer any more, so nothing was asked to continue.");
  }
  await reply(true, "Resumed and asked to continue.");
  void deliverToSession(session, RESUME_PROMPT, DELIVERY_TIMEOUT_MS, [], { ignorePause: true })
    .then((result) => {
      if (!result.ok) {
        process.stderr.write(`[monitor] resume of ${sessionId.slice(0, 8)} did not continue: ${result.error}\n`);
      }
    })
    .catch(() => {})
    .finally(afterContinue);
}

export async function handleCompact(client: RelayClient, message: SessionCompact): Promise<void> {
  const resultMessage = async (ok: boolean, text: string): Promise<void> => {
    const payload = {
        type: "session.compact.result",
        sessionId: message.sessionId,
        ok,
        message: text,
        createdAt: Date.now(),
      } as const;
    await sendSessionPayload(client, payload, message.sessionId, "phone", { ttlMs: 15 * 60_000 });
  };

  const session = scanSessions().sessions.find((item) => item.sessionId === message.sessionId);
  if (!session) return resultMessage(false, "This task is no longer available on the computer.");
  if (session.agent !== "codex") {
    return resultMessage(false, "Claude Code does not expose a supported remote compaction API.");
  }
  if (session.state === "working") {
    return resultMessage(false, "Wait for the active Codex turn to finish before compacting it.");
  }

  const result = await compactCodexSession(session.sessionId);
  await resultMessage(
    result.ok,
    result.ok ? "Codex context compaction completed." : `Context compaction failed: ${result.error}`,
  );
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

export function handleConfigSet(message: ConfigSet): void {
  applyConfigSet(message);
}

export function handleHostGrant(message: HostGrant): void {
  if (!acceptInstanceEpoch(message.instanceEpoch, loadConfigCommandState().requireFreshCommands)) {
    return;
  }
  applyHostGrant(message.projectId, message.grant, message.revision, computerId());
}
