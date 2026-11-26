// This computer's GrantTap account sign-in on the card: one callout with the only Sign in button, and a status row.
const MANAGED_COMPUTERS = "https://granttap.com/account#managed-computers";
const PASSKEY_PAGE = /^https:\/\/granttap\.com\/connect#request=[0-9a-f-]{36}$/i;

/** `accountLink` from the server; an older server's `accountLinkSaved` alone reads as ok or none. */
function accountOf(state) {
  const link = state.accountLink;
  if (link && typeof link.state === "string") return link;
  return { state: state.accountLinkSaved === true ? "ok" : "none", reason: "", checkedAt: null, answeredBy: null };
}
function signedIn(account) { return account.state !== "none" && account.state !== "revoked"; }
function notCovered(account) { return account.state === "seat_limit" || account.state === "no_subscription"; }
/** GrantTap's own relay admits only a computer signed in to an account; a computer's own relay does not ask. */
function grantTapRelay(state) { return !state.relay || state.relay === "relay.granttap.com"; }

/** Why phones cannot reach this paired computer, when the account is the reason; empty when it is not. */
function accountBlockedText(state) {
  const account = accountOf(state);
  if (state.status === "disconnected" || !grantTapRelay(state)) return "";
  if (account.state === "revoked") return "Signed out of GrantTap · phones cannot reach this computer";
  if (account.state === "none" && state.accountLink) return "Not signed in to GrantTap · phones cannot reach this computer";
  if (notCovered(account)) return "Not covered by your subscription · phones cannot reach this computer";
  return "";
}

function coverageText(account) {
  return account.state === "seat_limit"
    ? "Every computer place on your plan is in use. Turn another computer off under Managed computers, or choose a larger plan in GrantTap → Subscription."
    : "Subscribe in GrantTap → Subscription on your iPhone, or turn this computer on under Managed computers if your plan has room.";
}

/** The callout: [title, detail, button label or "" for none, show the Managed computers link]. */
function accountAlert(state, account) {
  const reason = account.reason ? ` (${account.reason.replace(/\.$/, "")})` : "";
  if (account.state === "revoked") {
    return ["Signed out of GrantTap", `GrantTap no longer accepts this computer's sign-in${reason}. Phones cannot reach it `
      + "through GrantTap's relay until you sign in again.", "Sign in again", false];
  }
  if (account.state === "none") {
    return grantTapRelay(state) && state.status !== "disconnected"
      ? ["This computer is not signed in", "Phones cannot reach it through GrantTap's relay until you sign in with your GrantTap passkey.", "Sign in", false]
      : ["Sign in to GrantTap", "Sign this computer in with your GrantTap passkey: a phone signed in to the same account then links it without a QR.", "Sign in", false];
  }
  if (notCovered(account)) {
    return ["This computer is not covered by your subscription",
      `${coverageText(account)}${account.reason ? ` GrantTap says: ${account.reason}` : ""}`, "", true];
  }
  if (account.state === "unreachable") {
    const since = typeof account.checkedAt === "number" ? ` Last tried ${relativeAge(Date.now() - account.checkedAt)}.` : "";
    return ["GrantTap's account service is not answering", `This computer keeps trying.${since} If it lasts, sign in again.`, "Sign in again", false];
  }
  return null;
}

/** The status row under This computer: what the sign-in is, in a few words. */
function accountStatusText(account) {
  if (account.state === "ok") {
    return typeof account.checkedAt === "number"
      ? "Signed in. Phones signed in to the same account link this computer without a QR."
      : "Signed in; checking with GrantTap…";
  }
  return { none: "Not signed in.", revoked: "Signed out by GrantTap.", seat_limit: "Signed in · not covered: the plan's computers are all in use.",
    no_subscription: "Signed in · not covered by a subscription.", unreachable: "Signed in · the account service is not answering." }[account.state]
    || "Unknown.";
}

function renderAccount(state, meta) {
  const account = accountOf(state);
  const candidate = state.passkeyUrl || meta.passkeyUrl;
  const passkeyUrl = typeof candidate === "string" && PASSKEY_PAGE.test(candidate) ? candidate : "";
  const alert = accountAlert(state, account);
  const [title, detail, action, coverage] = alert ?? ["Finish signing in", "", "", false];
  // A plan to change is information, not an alarm; a sign-in to do is.
  $("account-alert").classList.toggle("neutral", Boolean(coverage) && !passkeyUrl);
  show("account-alert", Boolean(alert) || Boolean(passkeyUrl));
  $("account-alert-title").textContent = title;
  $("account-alert-detail").textContent = passkeyUrl
    ? "Open granttap.com and confirm with your GrantTap passkey. The page is valid for 15 minutes; the passkey is entered only there."
    : detail;
  $("sign-in").textContent = action || "Sign in again";
  show("sign-in", Boolean(action) && !passkeyUrl);
  show("managed-computers", Boolean(coverage));
  $("managed-computers").setAttribute("href", MANAGED_COMPUTERS);
  show("passkey-link", Boolean(passkeyUrl));
  if (passkeyUrl) $("passkey-link").setAttribute("href", passkeyUrl);
  else $("passkey-link").removeAttribute("href");
  $("account-status").textContent = accountStatusText(account);
}
