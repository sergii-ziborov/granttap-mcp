export type ReplyResult =
  | { ok: true; text: string; sessionId?: string }
  | { ok: false; error: string };

export type DeliveryOptions = {
  preferredMcp?: string;
  skill?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** The resume prompt itself is sent while the hold is being lifted. */
  ignorePause?: boolean;
};
