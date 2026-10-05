import { z } from "zod";

/** A QR-paired phone grants this computer a machine-scoped account credential. */
export const AccountMachineLink = z.object({
  type: z.literal("account.machine.link"),
  accountId: z.string().uuid(),
  machineId: z.string().uuid(),
  machineToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createdAt: z.number().nonnegative(),
}).strict();
export type AccountMachineLink = z.infer<typeof AccountMachineLink>;
