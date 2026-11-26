import assert from "node:assert/strict";
import test from "node:test";
import type { AccountLinkStatus } from "../../../../bridge/src/account-link-state";
import { runSignIn, type SignInDeps } from "../sign-in-command";

const PAGE = "https://granttap.com/connect#request=11111111-1111-4111-8111-111111111111";
const ok: AccountLinkStatus = { state: "ok", reason: "Signed in.", checkedAt: 1 };

/** The command with fakes: the page "confirms" right after it is printed unless told otherwise. */
function command(overrides: Partial<SignInDeps> & { confirm?: boolean } = {}) {
  const out: string[] = [], opened: string[] = [];
  let listener: (() => void) | null = null;
  const deps: SignInDeps = {
    start: async () => PAGE,
    signedIn: next => { listener = next; if (overrides.confirm !== false) setImmediate(() => listener?.()); return () => { listener = null; }; },
    verify: async () => ok,
    linkFingerprint: () => null,
    paired: () => false,
    answering: () => "monitor",
    open: url => { opened.push(url); },
    write: text => { out.push(text); },
    timeoutMs: 20,
    ...overrides,
  };
  return { run: () => runSignIn(deps), text: () => out.join(""), opened };
}

test("granttap sign-in prints the page, opens it, waits, and says the phone links this computer", async () => {
  const cli = command();
  assert.equal(await cli.run(), 0);
  assert.ok(cli.text().startsWith(`Sign this computer in to GrantTap:\n\n  ${PAGE}\n\n`));
  assert.deepEqual(cli.opened, [PAGE]);
  assert.match(cli.text(), /Signed in to GrantTap\.\nOpen GrantTap on your iPhone signed in to the same account: it links this computer by itself, no QR needed\.\n$/);
  const paired = command({ paired: () => true, answering: () => null });
  assert.equal(await paired.run(), 0);
  assert.match(paired.text(), /reach this computer again; nothing else to do\.\nNo GrantTap helper is running on this computer to answer the phone: run granttap setup first\.\n$/);
});

test("granttap sign-in says what went wrong: no page, an expired page, a sign-in GrantTap refused", async () => {
  const unavailable = command({ start: async () => { throw new Error("offline"); } });
  assert.equal(await unavailable.run(), 1);
  assert.match(unavailable.text(), /could not start the sign-in/);
  const expired = command({ confirm: false });
  assert.equal(await expired.run(), 1);
  assert.match(expired.text(), /The page expired before the sign-in was confirmed\. Run granttap sign-in again\.\n$/);
  let fingerprint: string | null = null;
  const unannounced = command({ confirm: false, linkFingerprint: () => fingerprint, start: async () => { fingerprint = null; setImmediate(() => { fingerprint = "new"; }); return PAGE; } });
  assert.equal(await unannounced.run(), 0, "a sign-in saved while the page could not say so still counts");
  const refused = command({ verify: async () => ({ state: "revoked", reason: "Machine access revoked.", checkedAt: 2 }) });
  assert.equal(await refused.run(), 1);
  assert.match(refused.text(), /GrantTap did not accept the sign-in: Machine access revoked\.\nRun granttap sign-in again\.\n$/);
  const uncovered = command({ verify: async () => ({ state: "seat_limit", reason: "Every computer place is in use.", checkedAt: 2 }) });
  assert.equal(await uncovered.run(), 0);
  assert.match(uncovered.text(), /not covered by your subscription yet: Every computer place is in use\./);
});
