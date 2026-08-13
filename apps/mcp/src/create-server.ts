/**
 * Shared GrantTap MCP tool registration for stdio and HTTP transports.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import QRCode from "qrcode";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RelayClient } from "../../../packages/core/relay-client";
import { loadConfig, machineConfigPath, normalizeRelayUrl } from "../../bridge/src/config";
import { isUnanswered } from "../../bridge/src/approval";
import {
  CODEX_TRUST_INSTRUCTION,
  installClaudeHook,
  installCodexHook,
  installCursorHook,
  installMonitorHelper,
} from "../../bridge/src/install";
import { randomId } from "../../../packages/core/crypto";
import type { Payload } from "../../../packages/protocol/schema";
import {
  createOneTimePairing,
  DEFAULT_RELAY,
  PAIRING_CODE_TTL_MINUTES,
  reusablePairing,
} from "../../bridge/src/pairing";
import { formatConnectPasteText, writePairUriDesktopFile } from "../../bridge/src/pair-uri-file";
import { startSessionMonitor, type SessionMonitor } from "../../bridge/src/monitor";
import { requestApproval } from "../../bridge/src/approval";
import {
  sendApprovalResolved,
  terminalApproval,
} from "../../bridge/src/approval-state";
import { isMachineConfigured } from "./pairing-status";
import { isCursorHttpMcpConfigured } from "./cursor-config";
import { installHttpMcpService } from "./http-service";

const ASK_TIMEOUT_MS = Number(
  process.env.GRANTTAP_ASK_TIMEOUT_MS ?? process.env.NODVOX_ASK_TIMEOUT_MS ?? 180_000,
);

const NOT_PAIRED =
  "GrantTap is not paired on this machine. Pair the desktop bridge with the GrantTap app first.";

let client: RelayClient | null = null;
let monitor: SessionMonitor | null = null;

export async function relay(): Promise<RelayClient | null> {
  try {
    if (!client) {
      const cfg = loadConfig(machineConfigPath());
      client = new RelayClient(cfg, { autoReconnect: true });
      monitor = startSessionMonitor(client);
    }
    await client.connect();
    await monitor?.publish().catch(() => {});
    return client;
  } catch {
    return null;
  }
}

export function resetRelay(): void {
  monitor?.close();
  monitor = null;
  client?.close();
  client = null;
}

export async function askYesNo(
  client: RelayClient,
  question: string,
  timeoutMs = ASK_TIMEOUT_MS,
): Promise<string> {
  const requestId = randomId(6);
  const request = {
    type: "approval.request" as const,
    requestId,
    agent: "granttap",
    kind: "permission" as const,
    tool: "ask_yes_no",
    title: question,
    risk: "low" as const,
    createdAt: Date.now(),
  };
  const decision = await requestApproval(loadConfig(machineConfigPath()), request, {
    client,
    timeoutMs,
  });
  // Nobody tapped (phone asleep / relay down) is not a "no" — keep it distinct
  // so the agent can tell a real decline from an unanswered prompt.
  if (isUnanswered(decision)) {
    return "no-answer (timeout)";
  }
  return decision.decision === "allow" ? "yes" : "no";
}

export async function askOpenQuestion(
  client: RelayClient,
  question: string,
  timeoutMs = ASK_TIMEOUT_MS,
): Promise<string> {
  const requestId = randomId(6);
  type Reply = Extract<Payload, { type: "user.message" }>;
  let cancelReplyWait = () => {};
  const replyP = new Promise<Reply | null>((resolve) => {
    let settled = false;
    let handling = false;
    let appliedTerminal: ReturnType<typeof terminalApproval> | undefined;
    let off = () => {};
    const finish = (reply: Reply | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(reply);
    };
    cancelReplyWait = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    off = client.onMessage(async (payload: Payload) => {
      if (
        payload.type !== "user.message" ||
        payload.requestId !== requestId ||
        payload.sessionId?.trim() ||
        handling
      ) return false;
      handling = true;
      appliedTerminal ??= terminalApproval(requestId, "applied", {
        note: "Open question answered",
      });
      try {
        // A relay ACK alone is not enough for the phone's durable outbox or
        // question card. Emit both machine-authoritative receipts first.
        await sendApprovalResolved(client, appliedTerminal);
        if (payload.messageId) {
          await client.send({
            type: "delivery.receipt",
            messageId: payload.messageId,
            status: "accepted",
            receivedAt: Date.now(),
          }, "phone", { ttlMs: 24 * 60 * 60_000 });
        }
        finish(payload);
        return true;
      } catch {
        handling = false;
        return false;
      }
    });
  });
  try {
    await client.send(
      {
        type: "agent.event",
        text: question,
        requestId,
        kind: "question",
        createdAt: Date.now(),
      },
      "phone",
      { ttlMs: timeoutMs, wake: true },
    );
  } catch (error) {
    cancelReplyWait();
    throw error;
  }
  const reply = await replyP;
  if (!reply) {
    await sendApprovalResolved(
      client,
      terminalApproval(requestId, "expired", {
        note: "No response before timeout",
      }),
    ).catch(() => {});
  }
  return reply ? reply.text : "no-answer (timeout)";
}

export function createGrantTapServer(): McpServer {
  const server = new McpServer({
    name: "granttap",
    title: "GrantTap",
    version: "0.6.8",
    websiteUrl: "https://granttap.com",
    icons: [
      {
        src: "https://granttap.com/favicon.png",
        mimeType: "image/png",
        sizes: ["64x64"],
      },
    ],
  });

  server.tool(
    "connect",
    "Reuse this computer's GrantTap pairing, or create a one-time QR when none exists. Set replace only when the user explicitly asks to replace the pairing.",
    {
      relayUrl: z
        .string()
        .max(2_048)
        .url()
        .refine((value) => {
          try {
            normalizeRelayUrl(value);
            return true;
          } catch {
            return false;
          }
        }, {
          message: "Relay URL must use wss:// (or loopback ws:// for local development)",
        })
        .optional()
        .describe("Optional wss:// relay URL. Omit to use the GrantTap production relay."),
      replace: z.boolean().optional().describe("Explicitly replace the existing pairing and rotate keys."),
    },
    async ({ relayUrl, replace }): Promise<CallToolResult> => {
      try {
        const existing = reusablePairing(replace ?? false);
        if (existing) {
          return {
            content: [{
              type: "text",
              text: [
                "GrantTap existing secure pairing reused.",
                `Room: ${existing.room}`,
                `Relay: ${existing.relayUrl}`,
                "No QR or key rotation was needed.",
              ].join("\n"),
              annotations: { audience: ["user"] },
            }],
          };
        }
        const pairing = await createOneTimePairing(
          relayUrl ?? process.env.GRANTTAP_RELAY_URL ?? process.env.NODVOX_RELAY_URL ?? DEFAULT_RELAY,
        );
        resetRelay();
        void relay();
        const png = await QRCode.toBuffer(pairing.qrPayload, {
          type: "png",
          width: 900,
          margin: 4,
          errorCorrectionLevel: "L",
        });
        return {
          content: [
            {
              type: "text",
              text: [
                "Pair this Mac with GrantTap (QR optional — paste is enough):",
                "",
                "PASTE THIS in GrantTap → Settings → Connections → Paste / Add computer:",
                pairing.qrPayload,
                "",
                `Relay: ${pairing.httpBase}`,
                `One-time link — expires in ${PAIRING_CODE_TTL_MINUTES} minutes.`,
                "Also on Desktop: GrantTap-pair-uri.txt (when connect writes it).",
              ].join("\n"),
              annotations: { audience: ["user"] },
            },
            {
              type: "image",
              data: png.toString("base64"),
              mimeType: "image/png",
              annotations: { audience: ["user"] },
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `GrantTap pairing could not be created: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "notify",
    "Push a short status/message to the user's phone. Fire-and-forget — use it to keep them informed without blocking.",
    { message: z.string().min(1).max(8_000).describe("Text to show on the phone") },
    async ({ message }) => {
      const c = await relay();
      if (!c) return { content: [{ type: "text", text: NOT_PAIRED }] };
      await c.send(
        { type: "agent.event", text: message, kind: "status", createdAt: Date.now() },
        "phone",
        { ttlMs: 15 * 60_000, wake: true },
      );
      return { content: [{ type: "text", text: "sent to phone" }] };
    },
  );

  server.tool(
    "ask_yes_no",
    "Ask the user a yes/no question on their phone/watch and wait for the tap. Returns 'yes' or 'no'.",
    { question: z.string().min(1).max(8_000).describe("A question answerable with yes/no") },
    async ({ question }) => {
      const c = await relay();
      if (!c) return { content: [{ type: "text", text: NOT_PAIRED }] };
      const answer = await askYesNo(c, question);
      return { content: [{ type: "text", text: answer }] };
    },
  );

  server.tool(
    "ask",
    "Ask the user an open question on their phone/watch and wait for their spoken or typed reply. Returns their answer text.",
    { question: z.string().min(1).max(8_000).describe("The question to ask") },
    async ({ question }) => {
      const c = await relay();
      if (!c) return { content: [{ type: "text", text: NOT_PAIRED }] };
      return {
        content: [{ type: "text", text: await askOpenQuestion(c, question) }],
      };
    },
  );

  server.tool(
    "setup",
    "Register GrantTap Cursor, Claude Code, and Codex policy hooks plus terminal-free background task sync on this machine. OAuth remains a separate granttap authorize step.",
    {},
    async () => {
      const cursor = installCursorHook();
      const claude = installClaudeHook();
      const codex = installCodexHook();
      const monitorHelper = installMonitorHelper();
      const oauth = isCursorHttpMcpConfigured() ? installHttpMcpService() : null;
      const configured = isMachineConfigured();
      return {
        content: [
          {
            type: "text",
            text: [
              `Cursor: ${cursor.status} (${cursor.detail})`,
              `Claude: ${claude.status} (${claude.detail})`,
              `Codex: action required — hook ${codex.status} (${codex.detail}). ${CODEX_TRUST_INSTRUCTION}`,
              `Background task sync: ${monitorHelper.status} (${monitorHelper.detail})`,
              oauth
                ? `Persistent Cursor OAuth: ${oauth.status} (${oauth.detail})`
                : "Persistent Cursor OAuth: not configured (run granttap authorize if wanted)",
              "",
              "Cursor shell/MCP policy hooks are installed above. Settings → Authorize (OAuth) is separate:",
              "  granttap authorize",
              "Then set ~/.cursor/mcp.json granttap to:",
              '  { "url": "http://127.0.0.1:17342/mcp" }',
              configured
                ? "This machine already has local pairing keys; Authorize will confirm linking Cursor."
                : "This machine is not paired yet; Authorize will offer a pairing QR first.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  return server;
}
