import { z } from "zod";

const RequestId = z.string().uuid();

/** A trusted phone asks its paired computer to mint a separate controller key. */
export const ControllerPairRequest = z.object({
  type: z.literal("controller.pair.request"),
  requestId: RequestId,
  createdAt: z.number().nonnegative(),
}).strict();
export type ControllerPairRequest = z.infer<typeof ControllerPairRequest>;

/** Sent only through the authenticated device box, never a Project channel. */
export const ControllerPairOffer = z.object({
  type: z.literal("controller.pair.offer"),
  requestId: RequestId,
  room: z.string().regex(/^[a-f0-9]{16,64}$/),
  status: z.enum(["ready", "rejected"]),
  uri: z.string().max(1024).optional(),
  expiresAt: z.number().nonnegative().optional(),
  reason: z.string().max(200).optional(),
  createdAt: z.number().nonnegative(),
}).strict().superRefine((offer, ctx) => {
  if (offer.status === "ready" && (!offer.uri?.startsWith("granttap://pair-v2?")
    || !offer.expiresAt || offer.expiresAt <= offer.createdAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ready offer needs a valid URI and expiry" });
  }
  if (offer.status === "rejected" && offer.uri) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rejected offer cannot carry a URI" });
  }
});
export type ControllerPairOffer = z.infer<typeof ControllerPairOffer>;
