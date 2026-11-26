/**
 * What the account service's answers say about this computer's saved sign-in. Only the status, the
 * server's short `error` sentence and an optional `code` are read; the machine token never leaves the
 * request that carried it.
 */
export type AccountCheck =
  | { kind: "valid" }
  | { kind: "revoked"; reason: string }
  | { kind: "not_covered"; state: "seat_limit" | "no_subscription"; reason: string }
  | { kind: "unreachable"; reason: string };

export const SIGNED_OUT = "GrantTap no longer accepts this computer's sign-in.";
export const NOT_COVERED = "No active GrantTap subscription covers this computer, or the plan's computer limit is reached.";
const SEAT_CODES = new Set(["seat_limit", "computer_limit"]);
const SUBSCRIPTION_CODES = new Set(["no_subscription", "subscription_required", "subscription_expired"]);

/** One line a person can read: control characters and runs of space folded, at most 200 characters. */
export function shortReason(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

async function serverSaid(response: Response): Promise<{ code?: string; error?: string }> {
  try {
    const body = await response.clone().json() as { code?: unknown; error?: unknown };
    return {
      code: typeof body.code === "string" ? body.code : undefined,
      error: typeof body.error === "string" && body.error.trim() ? shortReason(body.error) : undefined,
    };
  } catch { return {}; }
}

function unreachable(status: number): AccountCheck {
  return { kind: "unreachable", reason: `GrantTap's account service answered ${status}; this computer tries again.` };
}

/** `GET /api/account/machine/requests` or `/machine/identity`: 401 is the only answer that means signed out. */
export async function pollAnswer(response: Response): Promise<AccountCheck> {
  if (response.ok) return { kind: "valid" };
  if (response.status === 401) return { kind: "revoked", reason: (await serverSaid(response)).error ?? SIGNED_OUT };
  return unreachable(response.status);
}

/**
 * `POST /api/account/machine/admission`. 401 is a revoked sign-in. 403 is a subscription that does not cover
 * this computer, unless it names the computer revoked. The server's `code`, when it sends one, tells a full
 * plan from no plan; the 0.8.214-era server sends one sentence for both, read as `no_subscription` with that
 * sentence as the reason. 404 and 503 are an unavailable service: never a grant, never a sign-out.
 */
export async function admissionAnswer(response: Response): Promise<AccountCheck> {
  if (response.ok) return { kind: "valid" };
  const said = await serverSaid(response);
  if (response.status === 401) return { kind: "revoked", reason: said.error ?? SIGNED_OUT };
  if (response.status !== 403) return unreachable(response.status);
  if (said.code && SEAT_CODES.has(said.code)) return { kind: "not_covered", state: "seat_limit", reason: said.error ?? NOT_COVERED };
  if (said.code && SUBSCRIPTION_CODES.has(said.code)) {
    return { kind: "not_covered", state: "no_subscription", reason: said.error ?? NOT_COVERED };
  }
  if (said.error && /\brevoked\b/i.test(said.error)) return { kind: "revoked", reason: said.error };
  if (said.error && /computer limit/i.test(said.error) && !/no active/i.test(said.error)) {
    return { kind: "not_covered", state: "seat_limit", reason: said.error };
  }
  return { kind: "not_covered", state: "no_subscription", reason: said.error ?? NOT_COVERED };
}

/** A request that never got an answer: offline, DNS, TLS, or the eight-second timeout. */
export function failedRequest(error: unknown): AccountCheck {
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;
  const name = typeof code === "string" ? code : error instanceof Error ? error.name : "error";
  return { kind: "unreachable", reason: `GrantTap's account service could not be reached (${shortReason(name)}); this computer tries again.` };
}
