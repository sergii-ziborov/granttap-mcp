import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withStoreLock } from "../../../../packages/core/store-file-lock";
import { loadAccountLink, type AccountLink } from "../account-recovery/link";
import { writePrivateFile } from "../config/access/write-private";
import { configDir } from "../config/runtime/paths";
import { failedRequest, pollAnswer, type AccountCheck } from "./server-answers";

export { accountServiceOrigin } from "./origin";
export { admissionAnswer, failedRequest, pollAnswer, shortReason, type AccountCheck } from "./server-answers";

export const ACCOUNT_LINK_STATES = ["none", "ok", "revoked", "seat_limit", "no_subscription", "unreachable"] as const;
export type AccountLinkState = typeof ACCOUNT_LINK_STATES[number];
/** This computer's sign-in to a GrantTap account, as the account service last answered for it. */
export type AccountLinkStatus = { state: AccountLinkState; reason: string; checkedAt: number | null };
/** Who asked: the phone-request poll, a relay admission, or a sign-in that just finished. */
export type CheckSource = "poll" | "admission" | "sign-in";

const SCHEMA = "granttap.account-link-status.v1";
type Stored = AccountLinkStatus & { schema: typeof SCHEMA; link: string };

export const NOT_SIGNED_IN = "This computer is not signed in to a GrantTap account.";
export const NOT_CHECKED = "Signed in; GrantTap has not confirmed it yet.";
const SIGNED_IN = "Signed in.";
/** Failed checks in a row, about half a minute of polling, before a working sign-in is called unreachable. */
export const UNREACHABLE_AFTER = 3;
/** A state that does not change is written again at most this often, so checkedAt stays within a minute. */
const REFRESH_MS = 60_000;

/** Unanswered checks in a row in this process, for one sign-in; any answer, or a new sign-in, resets it. */
let unanswered = { link: "", count: 0 };

const statusPath = () => join(configDir(), "account-link-status.json");

/** Names one saved sign-in without keeping anything that could sign in: a new sign-in starts a new state. */
export function linkFingerprint(link: AccountLink): string {
  return createHash("sha256").update(`${link.accountId}:${link.machineId}:${link.machineToken}`).digest("hex").slice(0, 16);
}

function readStored(fingerprint: string): AccountLinkStatus | null {
  try {
    const row = JSON.parse(readFileSync(statusPath(), "utf8")) as Partial<Stored>;
    if (row.schema !== SCHEMA || row.link !== fingerprint || !ACCOUNT_LINK_STATES.includes(row.state as AccountLinkState)
      || row.state === "none" || typeof row.reason !== "string" || typeof row.checkedAt !== "number") return null;
    return { state: row.state as AccountLinkState, reason: row.reason, checkedAt: row.checkedAt };
  } catch { return null; }
}

/**
 * Read by every process (monitor, MCP service, a chat's MCP server, the card): no link file is `none`; a link
 * no check has answered for yet is `ok` with `checkedAt: null`, which is what a saved link meant before.
 */
export function accountLinkStatus(): AccountLinkStatus {
  const link = loadAccountLink();
  if (!link) return { state: "none", reason: NOT_SIGNED_IN, checkedAt: null };
  return readStored(linkFingerprint(link)) ?? { state: "ok", reason: NOT_CHECKED, checkedAt: null };
}

/** True when the state says signing in again is the cure: never signed in, or signed out by GrantTap. */
export function needsSignIn(status: AccountLinkStatus): boolean {
  return status.state === "none" || status.state === "revoked";
}

/** True when the sign-in works but the subscription does not cover this computer. */
export function notCovered(status: AccountLinkStatus): boolean {
  return status.state === "seat_limit" || status.state === "no_subscription";
}

/**
 * The next state, or null when this check changes nothing worth keeping. A poll or a sign-in check proves the
 * sign-in, not the subscription, so only an admission clears seat_limit or no_subscription. An unanswered check never
 * overrides an answer that said what is wrong, and calls a working sign-in unreachable only after
 * `UNREACHABLE_AFTER` in a row.
 */
export function nextAccountLinkState(previous: AccountLinkStatus | null, source: CheckSource, check: AccountCheck,
  failures: number, now: number): AccountLinkStatus | null {
  if (check.kind === "valid") {
    if (source !== "admission" && previous && notCovered(previous)) return null;
    return { state: "ok", reason: SIGNED_IN, checkedAt: now };
  }
  if (check.kind === "revoked") return { state: "revoked", reason: check.reason, checkedAt: now };
  if (check.kind === "not_covered") return { state: check.state, reason: check.reason, checkedAt: now };
  if (previous && previous.state !== "ok" && previous.state !== "unreachable") return null;
  if ((!previous || previous.state === "ok") && failures < UNREACHABLE_AFTER) return null;
  return { state: "unreachable", reason: check.reason, checkedAt: now };
}

function describe(previous: AccountLinkStatus | null, next: AccountLinkStatus): string | null {
  if (next.state === "ok") return previous && previous.state !== "ok" ? `ok again (was ${previous.state})` : null;
  return `${next.state}${previous ? ` (was ${previous.state})` : ""}: ${next.reason}`;
}

/**
 * Keep what an account-service answer says about this computer's sign-in, in one owner-only file every
 * GrantTap process reads. The read-compare-write runs under the file's lock, so a change is logged once
 * (`[account] …`) whichever process saw it first. A busy lock or a full disk keeps the last state; the
 * next check tries again.
 */
export function recordAccountCheck(source: CheckSource, check: AccountCheck, now = Date.now()): AccountLinkStatus {
  const link = loadAccountLink();
  if (!link) return { state: "none", reason: NOT_SIGNED_IN, checkedAt: null };
  const fingerprint = linkFingerprint(link);
  const count = check.kind !== "unreachable" ? 0 : unanswered.link === fingerprint ? unanswered.count + 1 : 1;
  unanswered = { link: fingerprint, count };
  try {
    return withStoreLock(statusPath(), () => {
      const previous = readStored(fingerprint);
      const next = nextAccountLinkState(previous, source, check, count, now);
      if (!next) return previous ?? { state: "ok", reason: NOT_CHECKED, checkedAt: null };
      const changed = !previous || previous.state !== next.state || previous.reason !== next.reason;
      if (changed || now - (previous?.checkedAt ?? 0) >= REFRESH_MS) {
        writePrivateFile(statusPath(), `${JSON.stringify({ schema: SCHEMA, link: fingerprint, ...next })}\n`);
      }
      const line = changed ? describe(previous, next) : null;
      if (line) process.stderr.write(`[account] this computer's GrantTap sign-in is ${line}\n`);
      return next;
    }, { waitMs: 500 });
  } catch {
    return accountLinkStatus();
  }
}

/** Ask the account service once whether it accepts this computer's saved sign-in, as after a sign-in. */
export async function verifyAccountLink(origin: string, request: typeof fetch = fetch): Promise<AccountLinkStatus> {
  const link = loadAccountLink();
  if (!link || new URL(origin).protocol !== "https:") return accountLinkStatus();
  try {
    const response = await request(`${origin}/api/account/machine/identity`, {
      headers: { authorization: `Bearer ${link.machineToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(8_000), redirect: "error",
    });
    return recordAccountCheck("sign-in", await pollAnswer(response));
  } catch (error) {
    return recordAccountCheck("sign-in", failedRequest(error));
  }
}

/** For tests: forget this process's count of unanswered checks. */
export function resetAccountCheckFailures(): void { unanswered = { link: "", count: 0 }; }
