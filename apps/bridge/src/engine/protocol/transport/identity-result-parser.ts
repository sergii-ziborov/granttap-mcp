import { ENGINE_PROTOCOL_VERSION, EngineProtocolError } from "./protocol-base";
import type { EngineWireObject } from "./protocol-types";

export function parseEngineIdentityResult(result: EngineWireObject): void {
  requireString(result.engine_version, "engine_version");
  if (result.operation === "engine.pong") return;
  if (result.protocol_version !== ENGINE_PROTOCOL_VERSION) {
    throw new EngineProtocolError("engine result protocol version mismatch");
  }
  requireBoundedString(result.cortex_version, "Cortex version", 64);
  requireBoundedString(result.cortex_revision, "Cortex revision", 64);
  requireBoundedString(result.weavatrix_version, "Weavatrix version", 64);
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EngineProtocolError(`engine ${field} is invalid`);
  }
}

function requireBoundedString(value: unknown, field: string, maximum: number): void {
  requireString(value, field);
  if (value.length > maximum) {
    throw new EngineProtocolError("engine result payload is invalid");
  }
}
