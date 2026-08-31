export const ENGINE_PROTOCOL_VERSION = 1 as const;
export const MAX_ENGINE_FRAME_BYTES = 64 * 1024;
export const MAX_ENGINE_PENDING_REQUESTS = 128;
export const DEFAULT_ENGINE_POLICY_TIMEOUT_MS = 50;

export type PolicyEffect = "inherit" | "allow" | "ask" | "deny";
export type PolicySource = "none" | "provider" | "account" | "project" | "task";

export type EngineOperation =
  | { operation: "engine.ping" }
  | { operation: "engine.version" }
  | {
    operation: "project.resolve";
    input: { project_id?: string; repository_id?: string };
  }
  | {
    operation: "policy.evaluate_action";
    input: {
      provider?: PolicyEffect;
      account?: PolicyEffect;
      project?: PolicyEffect;
      task?: PolicyEffect;
    };
  };

export type EngineRequest = {
  protocol_version: typeof ENGINE_PROTOCOL_VERSION;
  request_id: string;
} & EngineOperation;

export type EngineResult =
  | { operation: "engine.pong"; engine_version: string }
  | {
    operation: "engine.version";
    engine_version: string;
    protocol_version: typeof ENGINE_PROTOCOL_VERSION;
  }
  | {
    operation: "project.resolved";
    resolution: { project_id: string; compatibility_mode: boolean };
  }
  | {
    operation: "policy.evaluated";
    decision: { effect: PolicyEffect; source: PolicySource; reason: string };
  };

export type EngineWireObject = Record<string, unknown>;

export class EngineProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineProtocolError";
  }
}

export class EngineRemoteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineRemoteError";
    this.code = code;
  }
}

export function encodeEngineFrame(value: unknown): Buffer {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new EngineProtocolError("engine frame is not JSON serializable");
  }
  if (json === undefined) throw new EngineProtocolError("engine frame is not JSON serializable");
  const payload = Buffer.from(json, "utf8");
  if (payload.length === 0 || payload.length > MAX_ENGINE_FRAME_BYTES) {
    throw new EngineProtocolError("engine frame exceeds the 64 KiB limit");
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class EngineFrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): EngineWireObject[] {
    if (chunk.length === 0) return [];
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const decoded: EngineWireObject[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length === 0 || length > MAX_ENGINE_FRAME_BYTES) {
        this.buffered = Buffer.alloc(0);
        throw new EngineProtocolError("invalid engine frame length");
      }
      if (this.buffered.length < length + 4) break;
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      decoded.push(parseWireObject(payload));
    }
    return decoded;
  }
}

export function parseEngineResponse(value: unknown, requestId: string): EngineResult {
  const response = requireObject(value, "engine response");
  if (response.protocol_version !== ENGINE_PROTOCOL_VERSION) {
    throw new EngineProtocolError("engine protocol version mismatch");
  }
  if (response.request_id !== requestId) {
    throw new EngineProtocolError("engine response request_id mismatch");
  }
  if (response.status === "error") {
    const error = requireObject(response.error, "engine error");
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      throw new EngineProtocolError("engine error payload is invalid");
    }
    throw new EngineRemoteError(error.code, error.message);
  }
  if (response.status !== "ok") {
    throw new EngineProtocolError("engine response status is invalid");
  }
  return parseResult(response.result);
}

function parseWireObject(payload: Buffer): EngineWireObject {
  try {
    return requireObject(JSON.parse(payload.toString("utf8")), "engine frame");
  } catch (error) {
    if (error instanceof EngineProtocolError) throw error;
    throw new EngineProtocolError("engine frame is not valid JSON");
  }
}

function parseResult(value: unknown): EngineResult {
  const result = requireObject(value, "engine result");
  const operation = result.operation;
  if (operation === "engine.pong") {
    requireString(result.engine_version, "engine_version");
  } else if (operation === "engine.version") {
    requireString(result.engine_version, "engine_version");
    if (result.protocol_version !== ENGINE_PROTOCOL_VERSION) {
      throw new EngineProtocolError("engine result protocol version mismatch");
    }
  } else if (operation === "project.resolved") {
    const resolution = requireObject(result.resolution, "project resolution");
    requireString(resolution.project_id, "project_id");
    if (typeof resolution.compatibility_mode !== "boolean") invalidResult();
  } else if (operation === "policy.evaluated") {
    const decision = requireObject(result.decision, "policy decision");
    if (!isPolicyEffect(decision.effect) || !isPolicySource(decision.source)) invalidResult();
    requireString(decision.reason, "reason");
  } else {
    throw new EngineProtocolError("engine result operation is unsupported");
  }
  return result as EngineResult;
}

function requireObject(value: unknown, label: string): EngineWireObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EngineProtocolError(`${label} must be an object`);
  }
  return value as EngineWireObject;
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EngineProtocolError(`engine ${field} is invalid`);
  }
}

function invalidResult(): never {
  throw new EngineProtocolError("engine result payload is invalid");
}

function isPolicyEffect(value: unknown): value is PolicyEffect {
  return value === "inherit" || value === "allow" || value === "ask" || value === "deny";
}

function isPolicySource(value: unknown): value is PolicySource {
  return value === "none" || value === "provider" || value === "account"
    || value === "project" || value === "task";
}
