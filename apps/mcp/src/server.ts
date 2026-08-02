/**
 * GrantTap MCP server — the easy front door.
 *
 * Adding this to any MCP client (`claude mcp add granttap …`) gives the agent a
 * VOLUNTARY channel to your wrist, complementing the hook's involuntary gating:
 *
 *   ask         — ask you a free-text question, wait for the spoken/typed answer
 *   ask_yes_no  — ask a yes/no question, get Да/Нет from the watch
 *   notify      — push a status/message to the phone (fire-and-forget)
 *   connect     — return a secure one-time pairing QR directly in chat
 *   setup       — register the Claude/Codex approval hooks on this machine
 *
 * All traffic is E2E-encrypted through the same relay; the MCP server never sees
 * plaintext leave the machine unsealed.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import QRCode from "qrcode";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RelayClient } from "../../../packages/core/relay-client";
import { loadConfig, machineConfigPath } from "../../bridge/src/config";
import { installClaudeHook, installCodexHook, installMonitorHelper } from "../../bridge/src/install";
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

async function main(): Promise<void> {
  const server = new McpServer({
    name: "granttap",
    title: "GrantTap",
    version: "0.6.4",
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
        .url()
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
                `Manual secure token: ${pairing.manualToken}`,
                `Relay: ${pairing.httpBase}`,
                `The encrypted mailbox is single-use and expires after ${PAIRING_CODE_TTL_MINUTES} minutes.`,
                "The relay receives only a random mailbox id and ciphertext; the independent 256-bit transfer key stays in this QR/token.",
              ].join("\n"),
            },
            { type: "image", data: png.toString("base64"), mimeType: "image/png" },
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
    { message: z.string().describe("Text to show on the phone") },
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
    { question: z.string().describe("A question answerable with yes/no") },
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
    { question: z.string().describe("The question to ask") },
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
    "Register GrantTap approval hooks and terminal-free background task sync on this machine.",
    {},
    async () => {
      const claude = installClaudeHook();
      const codex = installCodexHook();
      const monitorHelper = installMonitorHelper();
      return {
        content: [
          {
            type: "text",
            text: [
              `Claude: ${claude.status} (${claude.detail})`,
              `Codex: ${codex.status} (${codex.detail})`,
              `Background task sync: ${monitorHelper.status} (${monitorHelper.detail})`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  await server.connect(new StdioServerTransport());
  // Start task publishing as soon as the MCP process starts. If the machine is
  // not paired yet, the `connect` tool resets and starts it after onboarding.
  void relay();
}

main().catch((err) => {
  process.stderr.write(`[granttap-mcp] ${(err as Error).message}\n`);
  process.exit(1);
});
