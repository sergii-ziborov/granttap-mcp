export const ENGINE_PROTOCOL_VERSION = 1 as const;
export const MAX_ENGINE_FRAME_BYTES = 512 * 1024;
export const MAX_ENGINE_PENDING_REQUESTS = 128;

/** A present but busy Engine gets time to enforce Project policy. */
export const DEFAULT_ENGINE_POLICY_TIMEOUT_MS = 2_000;

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
