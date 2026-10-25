export type ReplyResult =
  | { ok: true; text: string; sessionId?: string; delivery?: 'native' }
  | { ok: false; error: string; delivery?: 'native' };

export type DeliveryOptions = {
  /** Called only after provider output confirms this operation has started. */
  onAgentActivity?: (nativeSessionId: string) => void;
  /** Stable controller delivery ID, also used by the provider's native admission. */
  messageId?: string;
  /** Native host questions must never fall back to a second CLI conversation. */
  nativeOnly?: boolean;
  /** Computer-generated identity before temporary attachment paths are inserted. */
  intentDigest?: string;
  preferredMcp?: string;
  skill?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** The resume prompt itself is sent while the hold is being lifted. */
  ignorePause?: boolean;
};
