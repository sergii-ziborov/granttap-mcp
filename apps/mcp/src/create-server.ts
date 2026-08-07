/**
 * Shared GrantTap MCP tool registration for stdio and HTTP transports.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import QRCode from "qrcode";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RelayClient } from "../../../packages/core/relay-client";
import { loadConfig, machineConfigPath, normalizeRelayUrl } from "../../bridge/src/config";
import {
  installClaudeHook,
  installCodexHook,
  installCursorMcpHttpConfig,
  installCursorPluginLocal,
  installHttpServeHelper,
  installMonitorHelper,
} from "../../bridge/src/install";
import { randomId } from "../../../packages/core/crypto";
import type { Payload } from "../../../packages/protocol/schema";
import {
  createOneTimePairing,
  DEFAULT_RELAY,
  PAIRING_CODE_TTL_MINUTES,
} from "../../bridge/src/pairing";
import { startSessionMonitor, type SessionMonitor } from "../../bridge/src/monitor";

const ASK_TIMEOUT_MS = Number(
  process.env.GRANTTAP_ASK_TIMEOUT_MS ?? process.env.NODVOX_ASK_TIMEOUT_MS ?? 180_000,
);

/** One reconnecting relay client shared by all tool calls. Failed startup is not cached. */
let client: RelayClient | null = null;
let monitor: SessionMonitor | null = null;

async function relay(): Promise<RelayClient | null> {
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

function resetRelay(): void {
  monitor?.close();
  monitor = null;
  client?.close();
  client = null;
}

const NOT_PAIRED =
  "GrantTap is not paired on this machine. Pair the desktop bridge with the GrantTap app first.";

/** Build a fully registered GrantTap MCP server (transport not yet connected). */
export function createGrantTapServer(): McpServer {
  const server = new McpServer({
    name: "granttap",
    title: "GrantTap",
    version: "0.6.5",
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
    "Pair this computer with the GrantTap iPhone app. Use when the user asks to connect, pair, onboard, or show a pairing QR. Returns a one-time QR image directly in chat; no terminal command is needed.",
    {
      relayUrl: z
        .string()
        .max(2_048)
        .url()
        .refine((value) => {
          try { normalizeRelayUrl(value); return true; } catch { return false; }
        }, {
          message: "Relay URL must use wss:// (or loopback ws:// for local development)",
        })
        .optional()
        .describe("Optional wss:// relay URL. Omit to use the GrantTap production relay."),
    },
    async ({ relayUrl }): Promise<CallToolResult> => {
      try {
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
                "Scan this QR with GrantTap on iPhone to pair this computer.",
                `Relay: ${pairing.httpBase}`,
                `The encrypted mailbox is single-use and expires after ${PAIRING_CODE_TTL_MINUTES} minutes.`,
                "The relay receives only a random mailbox id and ciphertext; the independent 256-bit transfer key stays in this user-only QR.",
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
      const requestId = randomId(6);
      await c.send(
        {
          type: "approval.request",
          requestId,
          agent: "granttap",
          kind: "permission",
          tool: "ask",
          title: question,
          risk: "low",
          createdAt: Date.now(),
        },
        "phone",
        { ttlMs: ASK_TIMEOUT_MS, wake: true },
      );
      const decision = await c
        .waitFor(
          (p: Payload): p is Extract<Payload, { type: "approval.decision" }> =>
            p.type === "approval.decision" && p.requestId === requestId,
          ASK_TIMEOUT_MS,
        )
        .catch(() => null);
      const answer = decision ? (decision.decision === "allow" ? "yes" : "no") : "no-answer (timeout)";
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
      const requestId = randomId(6);
      await c.send(
        { type: "agent.event", text: question, requestId, kind: "question", createdAt: Date.now() },
        "phone",
        { ttlMs: ASK_TIMEOUT_MS, wake: true },
      );
      const reply = await c
        .waitFor(
          (p: Payload): p is Extract<Payload, { type: "user.message" }> =>
            p.type === "user.message" && p.requestId === requestId,
          ASK_TIMEOUT_MS,
        )
        .catch(() => null);
      return {
        content: [{ type: "text", text: reply ? reply.text : "no-answer (timeout)" }],
      };
    },
  );

  server.tool(
    "setup",
    "Register GrantTap approval hooks, background helpers, Cursor HTTP MCP (Authorize), and the local Cursor plugin on this machine.",
    {},
    async () => {
      const claude = installClaudeHook();
      const codex = installCodexHook();
      const monitorHelper = installMonitorHelper();
      const httpServe = installHttpServeHelper();
      const cursorMcp = installCursorMcpHttpConfig();
      const cursorPlugin = installCursorPluginLocal();
      return {
        content: [
          {
            type: "text",
            text: [
              `Claude: ${claude.status} (${claude.detail})`,
              `Codex: ${codex.status} (${codex.detail})`,
              `Background task sync: ${monitorHelper.status} (${monitorHelper.detail})`,
              `HTTP MCP serve (Authorize): ${httpServe.status} (${httpServe.detail})`,
              `Cursor MCP HTTP config: ${cursorMcp.status} (${cursorMcp.detail})`,
              `Cursor local plugin: ${cursorPlugin.status} (${cursorPlugin.detail})`,
              "",
              "Cursor Authorize requires HTTP MCP at http://127.0.0.1:17342/mcp.",
              "Keep granttap-mcp serve running (LaunchAgent com.granttap.mcp-http on macOS), then reload Cursor and use Authorize on the GrantTap plugin.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  return server;
}

/** Start task publishing as soon as an MCP process starts. */
export function startGrantTapBackground(): void {
  void relay();
}
