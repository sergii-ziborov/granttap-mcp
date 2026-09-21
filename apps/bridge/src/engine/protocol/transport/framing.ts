import {
  EngineProtocolError,
  MAX_ENGINE_FRAME_BYTES,
} from "./protocol-base";
import type { EngineWireObject } from "./protocol-types";

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
    throw new EngineProtocolError("engine frame exceeds the 512 KiB limit");
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

function parseWireObject(payload: Buffer): EngineWireObject {
  try {
    return requireObject(JSON.parse(payload.toString("utf8")));
  } catch (error) {
    if (error instanceof EngineProtocolError) throw error;
    throw new EngineProtocolError("engine frame is not valid JSON");
  }
}

function requireObject(value: unknown): EngineWireObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EngineProtocolError("engine frame must be an object");
  }
  return value as EngineWireObject;
}
