import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { configDir } from "../../../bridge/src/config/runtime/paths";
import { EngineClient } from "../../../bridge/src/engine/runtime/engine-client";
import {
  ENGINE_PROTOCOL_VERSION, EngineFrameDecoder, encodeEngineFrame,
} from "../../../bridge/src/engine/protocol/engine-protocol";
import { DesktopTaskActivityRunner } from "./task-activity-runner";
import { desktopReadOperation } from "./operations";

const DESKTOP_OPERATIONS = new Set([
  "engine.version", "project.list", "project.resolve", "project.get",
  "project.list_bindings", "policy.get", "policy.coverage",
  "graph.get_backbone", "memory.history", "invocation.history",
  "desktop.project", "desktop.mesh_snapshot", "desktop.workspace", "desktop.task_activity",
  "desktop.machine_load", "desktop.capability_usage", "desktop.task_image",
  "desktop.installed_skills", "desktop.policy_status", "desktop.policy_set", "desktop.project_auto_accept",
  "desktop.mesh_snapshots",
  "desktop.task_send",
  "desktop.task_create",
  "desktop.mesh_create",
  "desktop.invocation_history",
]);

function desktopOperationTimeout(operation: unknown, input: unknown): number {
  if (operation === "desktop.policy_set") return 60_000;
  if (operation === "desktop.policy_status") return 30_000;
  if (operation === "desktop.capability_usage"
    || operation === "desktop.mesh_snapshots") return 75_000;
  if (operation === "desktop.task_activity"
    || operation === "desktop.task_image") return 45_000;
  if (operation === "desktop.task_send"
    || operation === "desktop.task_create") return 250_000;
  if (operation === "desktop.mesh_snapshot"
    && (input as { enrich?: unknown } | undefined)?.enrich === "true") return 45_000;
  return 15_000;
}

/** Same-user desktop channel; Task sends require an exact persisted execution link. */
export async function startDesktopEngineBridge(options: {
  engineSocketPath?: string;
  storePath?: string;
  client?: Pick<EngineClient, "request" | "close">;
} = {}): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "granttap-desktop-"));
  const socketPath = join(directory, "engine.sock");
  const engine = options.client ?? new EngineClient({
    socketPath: options.engineSocketPath ?? join(configDir(), "engine.sock"),
  });
  const activity = new DesktopTaskActivityRunner();
  const enrichment = new DesktopTaskActivityRunner();
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.setTimeout(15_000, () => socket.destroy());
    const decoder = new EngineFrameDecoder();
    let used = false;
    socket.on("data", (chunk) => {
      if (used) { socket.destroy(); return; }
      try {
        const requests = decoder.push(chunk);
        if (requests.length === 0) return;
        used = true;
        if (requests.length !== 1) { socket.destroy(); return; }
        const request = requests[0]!;
        const requestId = request.request_id;
        const operation = request.operation;
        socket.setTimeout(desktopOperationTimeout(operation, request.input));
        if (request.protocol_version !== ENGINE_PROTOCOL_VERSION
          || typeof requestId !== "string" || requestId.length === 0
          || requestId.length > 128 || typeof operation !== "string"
          || !DESKTOP_OPERATIONS.has(operation)) {
          socket.destroy();
          return;
        }
        const input = request.input;
        if (input !== undefined && (input === null || typeof input !== "object"
          || Array.isArray(input))) { socket.destroy(); return; }
        const read = desktopReadOperation({ operation, queryInput: input,
          storePath: options.storePath, engine, activity, enrichment });
        void read.then(
          (result) => {
            if (!result) { socket.destroy(); return; }
            if (!socket.destroyed) socket.end(encodeEngineFrame({
              protocol_version: ENGINE_PROTOCOL_VERSION, request_id: requestId,
              status: "ok", result,
            }));
          },
          () => {
            if (!socket.destroyed) socket.end(encodeEngineFrame({
              protocol_version: ENGINE_PROTOCOL_VERSION, request_id: requestId,
              status: "error", error: {
                code: "ENGINE_UNAVAILABLE", message: "The local Engine is unavailable.",
              },
            }));
          },
        );
      } catch { socket.destroy(); }
    });
    socket.on("error", () => undefined);
  });
  server.maxConnections = 16;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    activity.close();
    enrichment.close();
    engine.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath,
    close: async () => {
      clients.forEach((socket) => socket.destroy());
      activity.close();
      enrichment.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
