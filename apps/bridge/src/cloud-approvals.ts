/**
 * Bounded HTTP client for the relay's private Web approval capability.
 *
 * Approval contents are intentionally sent only to the paired relay endpoint
 * authenticated by the random pushAuth capability. The returned page URL is a
 * private bearer capability and is exposed only by the explicit `granttap web`
 * command, never by status or monitor logs.
 */
import type { ApprovalDecision, ApprovalRequest } from "../../../packages/protocol/schema";
import type { PeerConfig } from "../../../packages/core/relay-client";
import { fetchCloudJson } from "./cloud-approvals/http";

export type CloudDangerLevel = "safe" | "caution" | "dangerous" | "destructive";

export type CloudApprovalCard = {
  requestId: string;
  danger: CloudDangerLevel;
  title: string;
  command?: string | null;
  cwd?: string | null;
  agent: string;
  tool?: string | null;
  sessionId?: string | null;
  createdAt?: number;
  ttlMs?: number;
};

export type CloudApprovalsPublishResult = {
  ok: boolean;
  pageUrl?: string;
  viewToken?: string;
  error?: string;
};

export type CloudApprovalSummary = {
  requestId: string;
  status: string;
  danger?: CloudDangerLevel;
  decidedBy?: string | null;
};

export type CloudApprovalListResult = {
  ok: boolean;
  pageUrl?: string;
  approvals: CloudApprovalSummary[];
  error?: string;
};

type CloudApprovalPublishBody = {
  ok?: boolean;
  pageUrl?: string;
  viewToken?: string;
  error?: string;
};

type CloudApprovalListBody = {
  ok?: boolean;
  pageUrl?: string;
  approvals?: CloudApprovalSummary[];
  error?: string;
};

const CLOUD_FETCH_TIMEOUT_MS = 5_000;
const CLOUD_CANCEL_TIMEOUT_MS = 750;

export function httpRelayBase(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

/** Accept only an uncredentialed private page on the configured relay origin. */
export function validatedCloudPageUrl(
  relayUrl: string,
  candidate: string | undefined,
): string | null {
  if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) return null;
  try {
    const expected = new URL(httpRelayBase(relayUrl));
    const page = new URL(candidate);
    if (page.origin !== expected.origin || page.username || page.password || page.hash) return null;
    if (page.protocol !== "https:" && page.protocol !== "http:") return null;
    return page.toString();
  } catch {
    return null;
  }
}

function inferredDanger(req: ApprovalRequest): CloudDangerLevel {
  const explicit = (req as ApprovalRequest & { danger?: unknown }).danger;
  if (["safe", "caution", "dangerous", "destructive"].includes(String(explicit))) {
    return explicit as CloudDangerLevel;
  }
  const command = (req.command ?? "").toLowerCase();
  if (
    (/\bgit\s+push\b/.test(command) && /(--force|--force-with-lease|-f)\b/.test(command))
    || /\bgit\s+reset\s+--hard\b/.test(command)
    || /\brm\s+-rf?\b/.test(command)
    || /\bsudo\b/.test(command)
    || /\b(drop|truncate)\s+table\b/.test(command)
    || /\bdd\s+if=/.test(command)
    || /\bchmod\s+-r\b/.test(command)
    || /:\s*>\s*\//.test(command)
  ) return "destructive";
  if (/\bgit\s+push\b/.test(command) || /\bnpm\s+publish\b/.test(command)) {
    return "dangerous";
  }
  return req.risk === "low" ? "safe" : req.risk === "high" ? "destructive" : "caution";
}

export function cardFromApprovalRequest(
  req: ApprovalRequest,
  extras?: { ttlMs?: number },
): CloudApprovalCard {
  return {
    requestId: req.requestId,
    danger: inferredDanger(req),
    title: req.title,
    command: req.command ?? null,
    cwd: req.cwd ?? null,
    agent: req.agent,
    tool: req.tool,
    sessionId: req.sessionId ?? null,
    createdAt: req.createdAt,
    ttlMs: extras?.ttlMs ?? 120_000,
  };
}

export async function publishCloudApproval(
  cfg: PeerConfig,
  card: CloudApprovalCard,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CloudApprovalsPublishResult> {
  if (!cfg.pushAuth) return { ok: false, error: "missing pushAuth" };
  const url = `${httpRelayBase(cfg.relayUrl)}/approvals?room=${encodeURIComponent(cfg.room)}`;
  try {
    const { response, value } = await fetchCloudJson<CloudApprovalPublishBody>(
      fetchImpl,
      url,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${cfg.pushAuth}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(card),
      },
      signal,
      CLOUD_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) return { ok: false, error: value.error ?? `HTTP ${response.status}` };
    return { ok: true, pageUrl: value.pageUrl, viewToken: value.viewToken };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function cancelCloudApproval(
  cfg: PeerConfig,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!cfg.pushAuth) return false;
  const url = `${httpRelayBase(cfg.relayUrl)}/approvals?room=${encodeURIComponent(cfg.room)}`
    + `&requestId=${encodeURIComponent(requestId)}`;
  try {
    const { response } = await fetchCloudJson<Record<string, unknown>>(
      fetchImpl,
      url,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${cfg.pushAuth}`, accept: "application/json" },
      },
      signal,
      CLOUD_CANCEL_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function listCloudApprovals(
  cfg: PeerConfig,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CloudApprovalListResult> {
  if (!cfg.pushAuth) return { ok: false, approvals: [], error: "missing pushAuth" };
  const url = `${httpRelayBase(cfg.relayUrl)}/approvals?room=${encodeURIComponent(cfg.room)}`;
  try {
    const { response, value } = await fetchCloudJson<CloudApprovalListBody>(
      fetchImpl,
      url,
      { headers: { authorization: `Bearer ${cfg.pushAuth}`, accept: "application/json" } },
      signal,
      CLOUD_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { ok: false, approvals: [], error: value.error ?? `HTTP ${response.status}` };
    }
    return { ok: true, pageUrl: value.pageUrl, approvals: value.approvals ?? [] };
  } catch (error) {
    return {
      ok: false,
      approvals: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Poll until the exact request is decided, cancelled, or times out. */
export async function waitCloudApprovalDecision(
  cfg: PeerConfig,
  requestId: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  pollMs = 400,
  signal?: AbortSignal,
): Promise<ApprovalDecision | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const listed = await listCloudApprovals(cfg, fetchImpl, signal);
    if (signal?.aborted) return null;
    const hit = listed.approvals.find((approval) => approval.requestId === requestId);
    if (hit && (hit.status === "allow" || hit.status === "deny")) {
      return {
        type: "approval.decision",
        requestId,
        decision: hit.status,
        decidedBy: hit.decidedBy ?? "web",
        note: "GrantTap Web approval page",
        decidedAt: Date.now(),
      };
    }
    await abortableSleep(pollMs, signal);
  }
  return null;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
