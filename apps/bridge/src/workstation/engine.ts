import { join } from "node:path";
import { configDir } from "../config/runtime/paths";
import {
  EngineRemoteError, type EngineWorkstationLoad, type EngineWorkstationSpace,
} from "../engine/protocol/engine-protocol";
import { EngineClient } from "../engine/runtime/engine-client";
import { engineFeatureEnabled, type EngineClientLike } from "../engine/runtime/engine-supervisor";

export type SpaceAnswer = EngineWorkstationSpace | "busy" | "unsupported" | "unavailable";

export type WorkstationEngine = {
  load(): Promise<EngineWorkstationLoad | undefined>;
  space(budgetMs: number): Promise<SpaceAnswer>;
  /** False once an Engine answered that it has no workstation operations (before 0.1.9). */
  supported(): boolean;
};

const UNSUPPORTED_RETRY_MS = 10 * 60_000;

/**
 * Engine 0.1.9 measures with linked SweepLoom. A space summary takes its own
 * connection, so a walk of half a minute never queues behind or ahead of the
 * short requests the shared connection carries.
 */
export function workstationEngine(options: {
  env?: NodeJS.ProcessEnv; connect?: () => EngineClientLike; now?: () => number;
} = {}): WorkstationEngine {
  const now = options.now ?? Date.now;
  const connect = options.connect
    ?? (() => new EngineClient({ socketPath: join(configDir(), "engine.sock") }));
  let shared: EngineClientLike | undefined;
  let unsupportedAt: number | undefined;
  const enabled = () => engineFeatureEnabled(options.env ?? process.env)
    && (unsupportedAt == null || now() - unsupportedAt > UNSUPPORTED_RETRY_MS);
  const refused = (error: unknown): boolean => {
    if (error instanceof EngineRemoteError && error.code === "INVALID_REQUEST") unsupportedAt = now();
    return unsupportedAt != null;
  };
  return {
    supported: () => engineFeatureEnabled(options.env ?? process.env) && unsupportedAt == null,
    async load() {
      if (!enabled()) return undefined;
      try {
        const result = await (shared ??= connect()).request(
          { operation: "workstation.load", input: { max_sessions: 8 } }, { timeoutMs: 3_000 });
        unsupportedAt = undefined;
        return result.operation === "workstation.load" ? result.load : undefined;
      } catch (error) {
        refused(error);
        return undefined;
      }
    },
    async space(budgetMs) {
      if (!enabled()) return unsupportedAt == null ? "unavailable" : "unsupported";
      const client = connect();
      try {
        const result = await client.request(
          { operation: "workstation.space", input: { budget_ms: budgetMs, max_items: 6 } },
          // One location being walked when the budget ends is finished first.
          { timeoutMs: budgetMs + 90_000 });
        unsupportedAt = undefined;
        return result.operation === "workstation.space" ? result.space : "unavailable";
      } catch (error) {
        if (error instanceof EngineRemoteError && error.code === "WORKSTATION_SPACE_BUSY") return "busy";
        return refused(error) ? "unsupported" : "unavailable";
      } finally { client.close(); }
    },
  };
}
