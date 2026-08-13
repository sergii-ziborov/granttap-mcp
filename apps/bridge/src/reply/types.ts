export type ReplyResult =
  | { ok: true; text: string; sessionId?: string }
  | { ok: false; error: string };

export type DeliveryOptions = {
  preferredMcp?: string;
  skill?: string;
};
