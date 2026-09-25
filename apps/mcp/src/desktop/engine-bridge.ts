import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { configDir } from "../../../bridge/src/config/runtime/paths";
import { EngineClient } from "../../../bridge/src/engine/runtime/engine-client";
import {
  ENGINE_PROTOCOL_VERSION, EngineFrameDecoder, encodeEngineFrame,
  type EngineOperation,
} from "../../../bridge/src/engine/protocol/engine-protocol";
import { desktopProjectCatalog } from "./project-catalog";
import { desktopMeshProject, desktopWorkspace } from "./mesh-project";
import { DesktopTaskActivityRunner } from "./task-activity-runner";

const READ_OPERATIONS = new Set([
  "engine.version", "project.list", "project.resolve", "project.get",
  "project.list_bindings", "policy.get", "policy.coverage",
  "graph.get_backbone", "memory.history", "invocation.history",
  "desktop.project", "desktop.workspace", "desktop.task_activity",
]);

/** Same-user, read-only Engine channel owned by MCP for the native Mac app. */
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
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.setTimeout(6_000, () => socket.destroy());
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
        if (request.protocol_version !== ENGINE_PROTOCOL_VERSION
          || typeof requestId !== "string" || requestId.length === 0
          || requestId.length > 128 || typeof operation !== "string"
          || !READ_OPERATIONS.has(operation)) {
          socket.destroy();
          return;
        }
        const input = request.input;
        if (input !== undefined && (input === null || typeof input !== "object"
          || Array.isArray(input))) { socket.destroy(); return; }
        const query = input === undefined ? { operation } : { operation, input };
        const localCatalog = operation === "project.list"
          ? desktopProjectCatalog(input, options.storePath) : undefined;
        const read = operation === "desktop.task_activity"
          ? activity.read(input, options.storePath)
          : operation.startsWith("desktop.")
            ? Promise.resolve(operation === "desktop.project"
              ? desktopMeshProject(input, options.storePath)
              : desktopWorkspace(options.storePath))
          : localCatalog
            ? Promise.resolve(localCatalog)
            : engine.request(query as EngineOperation, { timeoutMs: 5_000 });
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
    engine.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath,
    close: async () => {
      clients.forEach((socket) => socket.destroy());
      activity.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      engine.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
