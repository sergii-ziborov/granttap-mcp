/**
 * `native`: the provider's own owner took the message and its answer arrives through the chat's history.
 * `handed-over`: the run outlived a monitor that was being replaced; the next monitor delivers its outcome.
 */
export type ReplyResult =
  | { ok: true; text: string; sessionId?: string; delivery?: 'native' | 'handed-over' }
  | { ok: false; error: string; delivery?: 'native' };

export type DeliveryOptions = {
  /** Called only after provider output confirms this operation has started. */
  onAgentActivity?: (nativeSessionId: string) => void;
  /** Stable controller delivery ID, also used by the provider's native admission. */
  messageId?: string;
  /** Native host questions must never fall back to a second CLI conversation. */
  nativeOnly?: boolean;
  /** Correlated question answer; use serialized resume only when no desktop owner exists. */
  questionReply?: boolean;
  /** Computer-generated identity before temporary attachment paths are inserted. */
  intentDigest?: string;
  preferredMcp?: string;
  skill?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** The resume prompt itself is sent while the hold is being lifted. */
  ignorePause?: boolean;
  /**
   * Phone messages queued for this chat behind this one in the durable queue, read when the prompt is
   * written. Phone messages waiting in memory for the same chat are added to it. The prompt gets a
   * GrantTap line saying so; the controller's intent, and so the delivery's identity, stays the person's text.
   */
  queuedBehind?: number | (() => number);
};
