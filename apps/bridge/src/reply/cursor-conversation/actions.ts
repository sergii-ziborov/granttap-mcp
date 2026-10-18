import { resolve } from "node:path";
import { resolveCursorMcpCapability } from "../../providers/cursor-mcp-policy";
import { mcpCapabilityFingerprint } from "../../policy/capability-fingerprint";

type NativeCall = { kind: string; rawInput?: unknown; locations?: { path: string }[] };
type Action = { tool: string; input: Record<string, unknown>; command: string; details: string;
  capability?: ReturnType<typeof mcpCapabilityFingerprint> };

function mcpAction(raw: Record<string, unknown>, cwd: string): Action | undefined {
  if (typeof raw.providerIdentifier !== "string" || typeof raw.toolName !== "string"
    || !/^[\w.-]{1,160}$/.test(raw.toolName)) return;
  const capability = resolveCursorMcpCapability({ cwd, mcp_server_name: raw.providerIdentifier });
  if (!capability.server) return;
  const tool = `mcp__${capability.server}__${raw.toolName}`;
  if (tool.length > 240) return;
  const input = raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)
    ? raw.args as Record<string, unknown> : {};
  const command = `${capability.server}/${raw.toolName}`;
  return { tool, input, command, details: command, capability: mcpCapabilityFingerprint("cursor", {
    serverName: capability.server, transport: capability.transport, configHash: capability.configHash }) };
}

/** Inspect native action metadata before any phone approval or auto-accept. */
export function cursorAction(call: NativeCall, cwd: string): Action | undefined {
  const raw = typeof call.rawInput === "string" ? { command: call.rawInput }
    : call.rawInput && typeof call.rawInput === "object" && !Array.isArray(call.rawInput)
      ? call.rawInput as Record<string, unknown> : {};
  if (call.kind === "other") return mcpAction(raw, cwd);
  const tools: Record<string, string> = { execute: "Shell", read: "Read", search: "Grep",
    edit: "Edit", delete: "Write", move: "Write", fetch: "WebFetch" };
  const tool = call.kind === "search" && typeof raw.searchTerm === "string" ? "WebSearch" : tools[call.kind];
  if (!tool) return;
  const input = { ...raw };
  const path = raw.file_path ?? raw.path ?? call.locations?.[0]?.path;
  if (typeof path === "string" && path.trim()) input.file_path = resolve(cwd, path);
  if (["Read", "Edit", "Write"].includes(tool) && typeof input.file_path !== "string") return;
  if (tool === "Shell" && (typeof input.command !== "string" || !input.command.trim())) return;
  if (tool === "WebFetch" && (typeof input.url !== "string" || !/^https?:\/\//.test(input.url))) return;
  const command = typeof input.command === "string" ? input.command
    : typeof input.file_path === "string" ? `${tool} ${input.file_path}` : tool;
  const details = JSON.stringify(input, null, 2);
  if (details.length > 16_384) return;
  return { tool, input, command, details };
}
