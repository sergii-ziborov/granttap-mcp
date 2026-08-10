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
import {
  acceptApprovalDecision,
  markApprovalTerminal,
  registerPendingApproval,
  resolvedApprovalOutcome,
  resolvedFromOutcome,
  sendApprovalResolved,
  type ApprovalOutcome,
} from "./approval-state";
import {
  cancelCloudApproval,
  cardFromApprovalRequest,
  publishCloudApproval,
  waitCloudApprovalDecision,
} from "./cloud-approvals";
import { primeSessionKeys, sendSessionPayload } from "./session-keys";

/**
 * Nobody answered — relay unreachable, or the phone never responded before the
 * timeout. Neither is a human saying no, so every hook hands the question back
 * to the agent's own permission prompt instead of denying the tool call.
 */
export function isUnanswered(decision: ApprovalDecision): boolean {
  return (
    decision.decision === "deny" &&
    (decision.decidedBy === "unreachable" || decision.decidedBy === "expired")
  );
}

export type RequestApprovalOpts = {
  timeoutMs?: number;
  /** Inject a client in tests instead of opening a socket. */
  client?: RelayClient;
  /** Test-only HTTP transport injection; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Keep Web-decision tests fast without changing the production cadence. */
  cloudPollMs?: number;
};

export async function requestApproval(
  cfg: PeerConfig,
  req: ApprovalRequest,
  opts: RequestApprovalOpts = {},
): Promise<ApprovalDecision> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const client = opts.client ?? new RelayClient(cfg);
  const ownsClient = !opts.client;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cloudAbort = new AbortController();
  let cancelDecisionWait = () => {};
  const registration = registerPendingApproval(req);
  if (!registration.matched) {
    return failClosed(
      req,
      "Conflicting approval request id reuse was rejected before delivery",
    );
  }
  const registrationHandle = registration.handle;
  primeSessionKeys(client);

  try {
    if (ownsClient) {
      try {
        await client.connect();
      } catch (err) {
        const accepted = markApprovalTerminal(req.requestId, "expired", {
          decision: "deny",
          decidedBy: "unreachable",
          note: `Relay недоступен: ${(err as Error).message}`,
          sessionId: req.sessionId,
        }, Date.now(), registrationHandle);
        // Relay unreachable is a different animal from "phone stayed silent":
        // hooks translate it into "ask locally" so normal desk work keeps flowing.
        return accepted.outcome
          ? decisionFromOutcome(accepted.outcome, req)
          : {
              ...failClosed(req, `Relay недоступен: ${(err as Error).message}`),
              decidedBy: "unreachable",
            };
      }
    }
    const decisionP = new Promise<ApprovalDecision | null>((resolve) => {
      let settled = false;
      let durablePoll: NodeJS.Timeout | undefined;
      let off = () => {};
      const finish = (decision: ApprovalDecision | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (durablePoll) clearInterval(durablePoll);
        cloudAbort.abort();
        off();
        resolve(decision);
      };
      cancelDecisionWait = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      // The long-running desktop monitor may receive and durably accept the
      // same relay envelope first. Poll the shared registry so this one-shot
      // hook/MCP waiter cannot time out after the phone decision was ACKed.
      durablePoll = setInterval(() => {
        const outcome = resolvedApprovalOutcome(
          req.requestId,
          req.sessionId,
          registrationHandle,
        );
        if (outcome) finish(decisionFromOutcome(outcome, req));
      }, 200);
      off = client.onMessage(async (payload: Payload) => {
        if (payload.type !== "approval.decision") return false;
        const sameSession =
          (payload.sessionId?.trim() || undefined) ===
          (req.sessionId?.trim() || undefined);
        if (payload.requestId !== req.requestId || !sameSession) return false;
        const accepted = acceptApprovalDecision(payload, Date.now(), registrationHandle);
        if (!accepted.matched || !accepted.outcome) return false;
        const decision = decisionFromOutcome(accepted.outcome, req);
        let terminalSent = false;
        try {
          await sendApprovalResolved(
            client,
            resolvedFromOutcome(accepted.outcome, accepted.request),
          );
          terminalSent = true;
        } finally {
          // The decision is already durable even if the socket dropped while
          // sending its terminal acknowledgement. Leave the relay envelope
          // unacked in that case so the bridge/late waiter can retry it.
          finish(decision);
        }
        return terminalSent;
      });
      if (cfg.pushAuth) {
        void waitCloudApprovalDecision(
          cfg,
          req.requestId,
          timeoutMs,
          fetchImpl,
          opts.cloudPollMs ?? 400,
          cloudAbort.signal,
        ).then(async (webDecision) => {
          if (!webDecision) return;
          const scopedDecision: ApprovalDecision = {
            ...webDecision,
            sessionId: req.sessionId,
          };
          const accepted = acceptApprovalDecision(
            scopedDecision,
            Date.now(),
            registrationHandle,
          );
          if (!accepted.matched || !accepted.outcome) return;
          await sendApprovalResolved(
            client,
            resolvedFromOutcome(accepted.outcome, accepted.request),
          ).catch(() => {});
          finish(decisionFromOutcome(accepted.outcome, req));
        }).catch(() => {});
      }
    });
    // The request id is random and carries no task content. Reusing it as the
    // opaque delivery id lets a generic APNs action answer the request even if
    // iOS has not yet pulled and decrypted the full card.
    const sendOptions = {
      ttlMs: timeoutMs,
      wake: true,
      deliveryId: req.requestId,
    };
    const cloudPublish = cfg.pushAuth
      ? publishCloudApproval(
          cfg,
          cardFromApprovalRequest(req, { ttlMs: timeoutMs }),
          fetchImpl,
          cloudAbort.signal,
        )
      : Promise.resolve(null);
    let phoneSendError: unknown;
    try {
      if (req.sessionId) {
        await sendSessionPayload(client, req, req.sessionId, "phone", sendOptions);
      } else {
        await client.send(req, "phone", sendOptions);
      }
    } catch (error) {
      phoneSendError = error;
    }
    const cloudResult = await cloudPublish;
    // Either delivery path may carry the decision. Fail only when both could
    // not publish; never make Web availability depend on the phone send RTT.
    if (phoneSendError && !cloudResult?.ok) throw phoneSendError;
    const decision = await decisionP;

    if (decision) return decision;
    // `expired`, not `system`: nobody denied anything — the phone was asleep,
    // offline, or the app was killed. Hooks hand `expired` back to the agent's
    // own permission prompt. Reporting it as a plain deny bricks the agent:
    // every tool call stalls for the full timeout and then fails.
    const expired = markApprovalTerminal(req.requestId, "expired", {
      decision: "deny",
      decidedBy: "expired",
      note: "No response from phone before timeout",
      sessionId: req.sessionId,
    }, Date.now(), registrationHandle);
    if (!expired.outcome) {
      return {
        ...failClosed(req, "No response from phone before timeout"),
        decidedBy: "expired",
      };
    }
    await sendApprovalResolved(
      client,
      resolvedFromOutcome(expired.outcome, expired.request),
    ).catch(() => {});
    return decisionFromOutcome(expired.outcome, req);
  } catch (err) {
    // Transport blew up mid-flight (socket dropped, peer never attached). Like a
    // failed connect this is `unreachable`: no human ever saw the request.
    const expired = markApprovalTerminal(req.requestId, "expired", {
      decision: "deny",
      decidedBy: "unreachable",
      note: "Approval channel error",
      sessionId: req.sessionId,
    }, Date.now(), registrationHandle);
    if (!expired.outcome) {
      return {
        ...failClosed(req, `Approval channel error: ${(err as Error).message}`),
        decidedBy: "unreachable",
      };
    }
    await sendApprovalResolved(
      client,
      resolvedFromOutcome(expired.outcome, expired.request),
    ).catch(() => {});
    return decisionFromOutcome(expired.outcome, req);
  } finally {
    cloudAbort.abort();
    cancelDecisionWait();
    if (cfg.pushAuth) {
      // Remove decided/expired cards with an independent short timeout. The
      // parent signal is already aborted, so reusing it would skip cleanup.
      await cancelCloudApproval(cfg, req.requestId, fetchImpl).catch(() => false);
    }
    if (ownsClient) client.close();
  }
}

function decisionFromOutcome(
  outcome: ApprovalOutcome,
  req: ApprovalRequest,
): ApprovalDecision {
  if (outcome.kind === "decision") return outcome.decision;
  return {
    type: "approval.decision",
    requestId: req.requestId,
    decision: outcome.resolved.decision ?? "deny",
    sessionId: req.sessionId,
    note: outcome.resolved.note,
    decidedBy: outcome.resolved.decidedBy ?? "system",
    decidedAt: outcome.resolved.resolvedAt,
  };
}

function failClosed(req: ApprovalRequest, note: string): ApprovalDecision {
  return {
    type: "approval.decision",
    requestId: req.requestId,
    decision: "deny",
    sessionId: req.sessionId,
    note,
    decidedBy: "system",
    decidedAt: Date.now(),
  };
}
