import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { saveAccountLink } from "../../account-recovery/link";
import {
  accountLinkStatus, admissionAnswer, failedRequest, nextAccountLinkState, pollAnswer, recordAccountCheck,
  resetAccountCheckFailures, UNREACHABLE_AFTER, verifyAccountLink, type AccountCheck,
} from "..";

const link = { accountId: "11111111-1111-4111-8111-111111111111",
  machineId: "22222222-2222-4222-8222-222222222222", machineToken: "A".repeat(43) };

/** A private config directory with this computer signed in, and the `[account]` lines it logs. */
async function signedIn(t: TestContext, signIn = true) {
  const root = await mkdtemp(join(tmpdir(), "granttap-account-state-"));
  process.env.GRANTTAP_CONFIG_DIR = root;
  resetAccountCheckFailures();
  t.after(async () => { delete process.env.GRANTTAP_CONFIG_DIR; await rm(root, { recursive: true, force: true }); });
  if (signIn) saveAccountLink(link);
  const log: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => { log.push(String(chunk)); return true; });
  return { root, log };
}

const forbidden = (body: unknown) => Response.json(body, { status: 403 });

test("the account service's answers name what is wrong with this computer's sign-in", async () => {
  assert.deepEqual(await pollAnswer(Response.json({ requests: [] })), { kind: "valid" });
  assert.deepEqual(await pollAnswer(Response.json({ error: "Machine access revoked." }, { status: 401 })),
    { kind: "revoked", reason: "Machine access revoked." });
  assert.equal((await pollAnswer(new Response("busy", { status: 503 }))).kind, "unreachable");
  assert.deepEqual(await admissionAnswer(new Response(null, { status: 401 })),
    { kind: "revoked", reason: "GrantTap no longer accepts this computer's sign-in." });
  assert.deepEqual(await admissionAnswer(forbidden({ code: "seat_limit", error: "Every computer place is in use." })),
    { kind: "not_covered", state: "seat_limit", reason: "Every computer place is in use." });
  assert.deepEqual(await admissionAnswer(forbidden({ code: "subscription_required" })), { kind: "not_covered",
    state: "no_subscription", reason: "No active GrantTap subscription covers this computer, or the plan's computer limit is reached." });
  // Today's server says both in one sentence.
  assert.deepEqual(await admissionAnswer(forbidden({ error: "No active managed access or the computer limit has been reached." })),
    { kind: "not_covered", state: "no_subscription", reason: "No active managed access or the computer limit has been reached." });
  assert.deepEqual(await admissionAnswer(forbidden({ error: "The computer limit has been reached." })),
    { kind: "not_covered", state: "seat_limit", reason: "The computer limit has been reached." });
  assert.deepEqual(await admissionAnswer(forbidden({ error: "Computer access was revoked." })),
    { kind: "revoked", reason: "Computer access was revoked." });
  for (const status of [400, 404, 503]) assert.equal((await admissionAnswer(new Response(null, { status }))).kind, "unreachable");
  const offline = failedRequest(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }));
  assert.deepEqual(offline, { kind: "unreachable",
    reason: "GrantTap's account service could not be reached (ENOTFOUND); this computer tries again." });
  assert.equal((await admissionAnswer(Response.json({ error: "line\none\u0007".repeat(80) }, { status: 401 })) as { reason: string })
    .reason.length, 200);
});

test("transitions: a poll never clears a subscription refusal, an unanswered check never hides an answer", () => {
  const ok = { state: "ok" as const, reason: "Signed in.", checkedAt: 1 };
  const seat = { state: "seat_limit" as const, reason: "full", checkedAt: 1 };
  const revoked = { state: "revoked" as const, reason: "gone", checkedAt: 1 };
  const valid: AccountCheck = { kind: "valid" };
  const offline: AccountCheck = { kind: "unreachable", reason: "offline" };
  assert.equal(nextAccountLinkState(seat, "poll", valid, 0, 5), null);
  assert.equal(nextAccountLinkState(seat, "sign-in", valid, 0, 5), null);
  assert.deepEqual(nextAccountLinkState(seat, "admission", valid, 0, 5), { state: "ok", reason: "Signed in.", checkedAt: 5 });
  assert.deepEqual(nextAccountLinkState(ok, "poll", { kind: "revoked", reason: "gone" }, 0, 5),
    { state: "revoked", reason: "gone", checkedAt: 5 });
  assert.equal(nextAccountLinkState(revoked, "poll", offline, 9, 5), null);
  assert.equal(nextAccountLinkState(seat, "admission", offline, 9, 5), null);
  assert.equal(nextAccountLinkState(ok, "poll", offline, UNREACHABLE_AFTER - 1, 5), null);
  assert.equal(nextAccountLinkState(null, "poll", offline, UNREACHABLE_AFTER - 1, 5), null);
  assert.deepEqual(nextAccountLinkState(ok, "poll", offline, UNREACHABLE_AFTER, 5),
    { state: "unreachable", reason: "offline", checkedAt: 5 });
  assert.deepEqual(nextAccountLinkState({ ...ok, state: "unreachable" }, "poll", offline, 1, 5),
    { state: "unreachable", reason: "offline", checkedAt: 5 });
});

test("one owner-only state follows the poll and admission answers and logs each change once", async t => {
  const { root, log } = await signedIn(t, false);
  assert.deepEqual(accountLinkStatus(), { state: "none", reason: "This computer is not signed in to a GrantTap account.",
    checkedAt: null });
  saveAccountLink(link);
  assert.deepEqual(accountLinkStatus(), { state: "ok", reason: "Signed in; GrantTap has not confirmed it yet.", checkedAt: null });
  recordAccountCheck("poll", { kind: "valid" }, 1_000);
  assert.deepEqual(accountLinkStatus(), { state: "ok", reason: "Signed in.", checkedAt: 1_000 });
  assert.deepEqual(log, [], "a sign-in that works is not news");
  const file = join(root, "account-link-status.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8").includes(link.machineToken), false);

  const seat: AccountCheck = { kind: "not_covered", state: "seat_limit", reason: "Every computer place is in use." };
  recordAccountCheck("admission", seat, 2_000);
  recordAccountCheck("admission", seat, 2_500);
  recordAccountCheck("poll", { kind: "valid" }, 3_000);
  assert.equal(accountLinkStatus().state, "seat_limit");
  recordAccountCheck("admission", { kind: "valid" }, 4_000);
  recordAccountCheck("poll", { kind: "revoked", reason: "Machine access revoked." }, 5_000);
  for (let i = 0; i < 5; i++) recordAccountCheck("poll", { kind: "unreachable", reason: "offline" }, 6_000 + i);
  assert.deepEqual(accountLinkStatus(), { state: "revoked", reason: "Machine access revoked.", checkedAt: 5_000 });
  assert.deepEqual(log, [
    "[account] this computer's GrantTap sign-in is seat_limit (was ok): Every computer place is in use.\n",
    "[account] this computer's GrantTap sign-in is ok again (was seat_limit)\n",
    "[account] this computer's GrantTap sign-in is revoked (was ok): Machine access revoked.\n",
  ]);

  // Signing in again is a new sign-in: the revoked one no longer speaks for it.
  saveAccountLink({ ...link, machineToken: "B".repeat(43) });
  assert.equal(accountLinkStatus().state, "ok");
  for (let i = 0; i < UNREACHABLE_AFTER - 1; i++) recordAccountCheck("poll", { kind: "unreachable", reason: "offline" }, 7_000);
  assert.equal(accountLinkStatus().checkedAt, null, "a blip is not written down");
  recordAccountCheck("poll", { kind: "unreachable", reason: "offline" }, 8_000);
  assert.deepEqual(accountLinkStatus(), { state: "unreachable", reason: "offline", checkedAt: 8_000 });
  recordAccountCheck("poll", { kind: "valid" }, 9_000);
  assert.equal(accountLinkStatus().state, "ok");
  assert.equal(log.at(-1), "[account] this computer's GrantTap sign-in is ok again (was unreachable)\n");
});

test("a sign-in that just finished is checked once against the account service", async t => {
  await signedIn(t);
  const asked: string[] = [];
  const status = await verifyAccountLink("https://granttap.com", async (input, init) => {
    asked.push(`${String(input)} ${(init?.headers as Record<string, string>).authorization === `Bearer ${link.machineToken}`}`);
    return Response.json({ accountId: link.accountId, machineId: link.machineId });
  });
  assert.deepEqual(asked, ["https://granttap.com/api/account/machine/identity true"]);
  assert.equal(status.state, "ok");
  assert.equal(typeof status.checkedAt, "number");
  assert.equal((await verifyAccountLink("https://granttap.com", async () => new Response(null, { status: 401 }))).state, "revoked");
  let sent = false;
  await verifyAccountLink("http://granttap.test", async () => { sent = true; return Response.json({}); });
  assert.equal(sent, false, "a machine token never goes over plain http");
});
