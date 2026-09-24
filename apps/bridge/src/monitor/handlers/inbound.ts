import type { Payload } from "../../../../../packages/protocol/schema";
import type { RelayClient } from "../../../../../packages/core/relay-client";
import { storeAttachment } from "../../delivery/attachment-store";
import { abandonDelivery, beginDelivery, completeDelivery } from "../../delivery";
import { handleToolUpdate } from "../../tools/update-handler";
import { loadRuntimeConfig } from "../../config";
import { localMeshStore } from "../../mesh/local-remote/local";
import { sendProjectPayload } from "../../host/session-keys";
import {
  handleMeshPayload,
  prepareMeshHandoff,
  requestProjectCapability,
  invalidateMeshSessionHistory,
} from "../../mesh/runtime";
import { releaseClaimByPerson, releaseResult } from "../../mesh/admin";
import { handleInvocationQuery } from "../../engine/invocation/query";
import { applyPairingJoin } from "../../pairing";
import { recordPhoneSeen } from "../../pairing/presence";
import { handleProjectPolicySet } from "../../project-policy/runtime";
import { sendDeliveryReceipt } from "./receipts";
import {
  handleAccessSet,
  handleCompact,
  handleConfigSet,
  handleHostGrant,
  handleMcpSet,
  handleSessionControl,
  handleShellSet,
  handleSkillSet,
  handleSubscription,
} from "./session-commands";
import { handleTaskCreate } from "./task-create";
import { handleUserMessage } from "./user-message";
import { publishSessionEvents } from "./catalog";
import { publishHistoryPage } from "../history/pages";
import { requestProjectGraphRefresh } from "../graph-refresh";
import { handleControllerPairRequest, handleInboundKnowledgeWrite } from "../controller-knowledge";

export async function handleMonitorMessage(
  client: RelayClient,
  payload: Payload,
  input: {
    leadership: { acquire: () => boolean };
    subscriptions: Set<string>;
    publish: (forceHistory?: boolean) => Promise<void>;
    peerPublicKey?: string;
  },
): Promise<boolean> {
  const { leadership, subscriptions, publish } = input;
    if (payload.type === "pairing.join") {
      return handleInboundPairingJoin(payload);
    }
    recordPhoneSeen();
    // Codex may start one MCP server per open task. Exactly one instance owns
    // phone routing, so a single phone message can never create duplicate tasks.
    if (!leadership.acquire()) return false;
    if (payload.type === "controller.pair.request") {
      return handleControllerPairRequest(client, payload, input.peerPublicKey);
    }
    if (payload.type === "knowledge.write") {
      return handleInboundKnowledgeWrite(client, payload, input.peerPublicKey, publish);
    }
    if (payload.type === "user.message") {
      return handleInboundUserMessage(client, payload, publish);
    } else if (payload.type === "user.attachment") {
      // Ahead of its message, so the message itself travels light.
      return storeAttachment(payload, client.room);
    } else if (payload.type === "config.set") {
      handleConfigSet(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "project.task.create") {
      return handleInboundTaskCreate(client, payload, publish);
    } else if (payload.type === "project.execution.host-grant") {
      handleHostGrant(payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.subscribe") {
      return handleInboundSubscription(client, payload, subscriptions, publish);
    } else if (payload.type === "session.events") {
      void publishSessionEvents(client, payload.sessionId, undefined, payload.threadId).catch(() => false);
      return true;
    } else if (payload.type === "sessions.refresh") {
      return handleInboundRefresh(client, payload, publish);
    } else if (payload.type === "sessions.history.query") {
      await publishHistoryPage(client, payload);
      return true;
    } else if (payload.type === "session.access.set") {
      handleAccessSet(payload);
      void publish(true).catch(() => {});
      return true;
    } else if (payload.type === "session.mcp.set") {
      handleMcpSet(payload);
      void publish(true).catch(() => {});
      return true;
    } else if (payload.type === "session.skill.set") {
      handleSkillSet(payload);
      void publish(true).catch(() => {});
      return true;
    } else if (payload.type === "session.shell.set") {
      handleShellSet(payload);
      void publish(true).catch(() => {});
      return true;
    } else if (payload.type === "session.compact") {
      await handleCompact(client, payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "session.control") {
      await handleSessionControl(client, payload, () => { void publish().catch(() => {}); });
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "tool.update") {
      return handleInboundToolUpdate(client, payload, publish);
    } else if (payload.type === "project.policy.set" && loadRuntimeConfig().meshEnabled) {
      return handleProjectPolicySet(client, payload);
    } else if (payload.type === "project.capability.request" && loadRuntimeConfig().meshEnabled) {
      const accepted = requestProjectCapability(payload);
      if (accepted) void publish().catch(() => {});
      return accepted;
    } else if (payload.type === "mesh.invocation.query" && loadRuntimeConfig().meshEnabled) {
      return handleInvocationQuery(client, payload);
    } else if ((payload.type === "mesh.event" || payload.type === "mesh.snapshot")
      && loadRuntimeConfig().meshEnabled) {
      await handleMeshPayload(client, payload);
      void publish().catch(() => {});
      return true;
    } else if (payload.type === "mesh.handoff.prepare" && loadRuntimeConfig().meshEnabled) {
      const prepared = await prepareMeshHandoff(client, payload);
      if (prepared) void publish().catch(() => {});
      return prepared;
    } else if (payload.type === "mesh.claim.release" && loadRuntimeConfig().meshEnabled) {
      return handleInboundClaimRelease(client, payload, publish);
    }
    return false;
}

async function handleInboundClaimRelease(
  client: RelayClient, payload: Extract<Payload, { type: "mesh.claim.release" }>,
  publish: (forceHistory?: boolean) => Promise<void>,
): Promise<boolean> {
  // The person's authority is recorded and answered even when release fails.
  const outcome = releaseClaimByPerson(localMeshStore(), payload);
  await sendProjectPayload(client, releaseResult(payload, outcome), "phone", { ttlMs: 15 * 60_000 })
    .catch(() => {});
  if (outcome.released) void publish().catch(() => {});
  return true;
}

function handleInboundRefresh(
  client: RelayClient, payload: Extract<Payload, { type: "sessions.refresh" }>,
  publish: (forceHistory?: boolean) => Promise<void>,
): boolean {
  // An explicit refresh may pay for the full history scan; routine Mesh
  // snapshots use the cached history and fresh live sessions.
  invalidateMeshSessionHistory();
  void publish(true).catch(() => {});
  if (payload.graphProjectId && loadRuntimeConfig().meshEnabled) {
    requestProjectGraphRefresh(client, payload.graphProjectId);
  }
  return true;
}

function handleInboundToolUpdate(
  client: RelayClient, payload: Extract<Payload, { type: "tool.update" }>,
  publish: (forceHistory?: boolean) => Promise<void>,
): boolean {
  // Minutes long, so the relay loop does not wait on it. The phone sees the
  // intermediate status and the result when the update lands.
  void handleToolUpdate(
    (result) => client.send(result, "phone", { ttlMs: 15 * 60_000 }), payload,
  ).catch(() => {}).finally(() => { void publish().catch(() => {}); });
  void publish().catch(() => {});
  return true;
}

function handleInboundPairingJoin(payload: Extract<Payload, { type: "pairing.join" }>): boolean {
  const result = applyPairingJoin(payload);
  if (result === "adopted" && process.env.GRANTTAP_MONITOR_PRIMARY === "1") {
    setImmediate(() => process.exit(0));
  }
  return true;
}

async function handleInboundUserMessage(
  client: RelayClient, payload: Extract<Payload, { type: "user.message" }>,
  publish: (forceHistory?: boolean) => Promise<void>,
): Promise<boolean> {
  // Correlated replies belong to the MCP `ask` waiter in one process.
  if (payload.requestId) return false;
  let deliveryStarted = false;
  if (payload.messageId) {
    const state = beginDelivery(payload.messageId);
    if (state === "completed") {
      await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId);
      return true;
    }
    if (state === "processing") return false;
    deliveryStarted = true;
  }
  try {
    const outcome = await handleUserMessage(client, payload);
    if (payload.messageId && deliveryStarted) {
      if (outcome === "rejected") {
        // The phone sends the message again with what was missing; the
        // ledger must let that second copy through.
        abandonDelivery(payload.messageId);
      } else {
        completeDelivery(payload.messageId);
        await sendDeliveryReceipt(client, payload.messageId, "accepted", undefined, payload.sessionId);
      }
    }
    void publish().catch(() => {});
    return true;
  } catch {
    if (payload.messageId && deliveryStarted) abandonDelivery(payload.messageId);
    return false;
  }
}

async function handleInboundTaskCreate(
  client: RelayClient, payload: Extract<Payload, { type: "project.task.create" }>,
  publish: (forceHistory?: boolean) => Promise<void>,
): Promise<boolean> {
  const state = beginDelivery(payload.operationId);
  if (state === "completed") {
    await sendDeliveryReceipt(client, payload.operationId, "accepted");
    return true;
  }
  if (state === "processing") return false;
  try {
    const admission = await handleTaskCreate(client, payload);
    if (admission.status === "rejected") {
      abandonDelivery(payload.operationId);
      await sendDeliveryReceipt(client, payload.operationId, "rejected", admission.error);
      return true;
    }
    completeDelivery(payload.operationId);
    await sendDeliveryReceipt(client, payload.operationId, "accepted");
    void publish().catch(() => {});
    return true;
  } catch {
    abandonDelivery(payload.operationId);
    return false;
  }
}

function handleInboundSubscription(
  client: RelayClient, payload: Extract<Payload, { type: "session.subscribe" }>,
  subscriptions: Set<string>, publish: (forceHistory?: boolean) => Promise<void>,
): boolean {
  // The transcript goes first, before a potentially slow catalog rescan.
  void publishSessionEvents(client, payload.sessionId).catch(() => false);
  if (handleSubscription(subscriptions, payload)) {
    void publish(true).catch(() => {});
  }
  return true;
}
