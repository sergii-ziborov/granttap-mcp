import { seal } from "../../../packages/core/crypto";
import type { Envelope, Payload } from "../../../packages/protocol/schema";

type EnvelopeInput = {
  payload: Payload;
  room: string;
  from: "machine" | "phone";
  to: "machine" | "phone" | "all";
  senderSecretKey: string;
  recipientPublicKey: string;
  deliveryId?: string;
};

export function encryptedEnvelope(input: EnvelopeInput): Envelope {
  const encrypted = seal(input.payload, input.recipientPublicKey, input.senderSecretKey);
  return {
    v: 1,
    room: input.room,
    from: input.from,
    to: input.to,
    senderId: `${input.from}-1`,
    deliveryId: input.deliveryId ?? "delivery-1",
    nonce: encrypted.nonce,
    box: encrypted.box,
  };
}
