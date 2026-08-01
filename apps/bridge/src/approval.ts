/**
 * Core approval round-trip, agent-agnostic.
 *
 * Connect to the relay, send one ApprovalRequest, block until the paired phone
 * replies with a matching ApprovalDecision (or the timeout fires — fail closed,
 * i.e. deny). This is what makes a phone tap gate a real tool call.
 */
import type { PeerConfig } from "../../../packages/core/relay-client";
import { RelayClient } from "../../../packages/core/relay-client";
import type { ApprovalDecision, ApprovalRequest, Payload } from "../../../packages/protocol/schema";

export type RequestApprovalOpts = {
  timeoutMs?: number;
  /** Inject a client in tests instead of opening a socket. */
  client?: RelayClient;
};

export async function requestApproval(
  cfg: PeerConfig,
  req: ApprovalRequest,
  opts: RequestApprovalOpts = {},
): Promise<ApprovalDecision> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const client = opts.client ?? new RelayClient(cfg);
  const ownsClient = !opts.client;

  try {
    if (ownsClient) {
      try {
        await client.connect();
      } catch (err) {
        // Relay unreachable is a different animal from "phone stayed silent":
        // hooks translate it into "ask locally" so normal desk work keeps flowing.
        return {
          ...failClosed(req, `Relay недоступен: ${(err as Error).message}`),
          decidedBy: "unreachable",
        };
      }
    }
    // The request id is random and carries no task content. Reusing it as the
    // opaque delivery id lets a generic APNs action answer the request even if
    // iOS has not yet pulled and decrypted the full card.
    await client.send(req, "phone", {
      ttlMs: timeoutMs,
      wake: "approval",
      deliveryId: req.requestId,
    });
    const decision = await client
      .waitFor(
        (p: Payload): p is ApprovalDecision =>
          p.type === "approval.decision" && p.requestId === req.requestId,
        timeoutMs,
      )
      .catch(() => null);

    if (decision) return decision;
    return failClosed(req, "No response from phone before timeout");
  } catch (err) {
    return failClosed(req, `Approval channel error: ${(err as Error).message}`);
  } finally {
    if (ownsClient) client.close();
  }
}

function failClosed(req: ApprovalRequest, note: string): ApprovalDecision {
  return {
    type: "approval.decision",
    requestId: req.requestId,
    decision: "deny",
    note,
    decidedBy: "system",
    decidedAt: Date.now(),
  };
}
