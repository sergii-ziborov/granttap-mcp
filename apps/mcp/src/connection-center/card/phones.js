// What the Phones section shows and asks, with the same rules as the phone app's Devices → a computer →
// Phones (PairedPhones.swift): the server marks which phones a 30-day removal takes (`stale`, never the
// phone heard from most recently), the last phone has no Remove, and nothing is removed without a yes
// on a phone. No DOM here, so the rules are tested on their own.

const STALE_DAYS = 30;
/** Longer than remove_phones waits for the yes on a phone (about three minutes). */
const REMOVAL_WAIT_MS = 200_000;
/** A long list shows the phones heard from most recently and a "Show all" button. */
const PHONES_COLLAPSED = 5;
const PHONES_COLLAPSE_FROM = 8;

function plural(count, one, many = `${one}s`) { return `${count} ${count === 1 ? one : many}`; }

/** "just now", "5 min ago", "3 h ago", "12 days ago", "4 months ago", "2 years ago". */
function relativeAge(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${plural(days, "day")} ago`;
  if (days < 365) return `${plural(Math.floor(days / 30), "month")} ago`;
  return `${plural(Math.floor(days / 365), "year")} ago`;
}

/** The name the phone reported; the server names the rest "Phone <label>" or "First pairing", as the app does. */
function phoneTitle(phone) {
  const name = typeof phone.name === "string" ? phone.name.trim() : "";
  return name || (phone.primary ? "First pairing" : `Phone ${phone.label}`);
}

function lastSeenText(phone, now) {
  if (typeof phone.lastSeenAt === "number") return `Last seen ${relativeAge(now - phone.lastSeenAt)}`;
  return typeof phone.addedAt === "number" ? `Never seen · added ${relativeAge(now - phone.addedAt)}` : "Never seen";
}

/** The second line of a row: when it was last seen, the first pairing when its name does not say so, its label. */
function phoneDetail(phone, now) {
  const title = phoneTitle(phone);
  return [lastSeenText(phone, now), ...(phone.primary && title !== "First pairing" ? ["first pairing"] : []),
    ...(title.includes(phone.label) ? [] : [phone.label])].join(" · ");
}

/** "Active now" for a phone heard from in the last minute, else "Last active" for the phone heard from most recently. */
function phoneBadge(phone) {
  if (phone.status === "seen") return { text: "Active now", tone: "ok" };
  if (phone.mostRecent && typeof phone.lastSeenAt === "number") return { text: "Last active", tone: "neutral" };
  return undefined;
}

/** Most recently heard from first; never seen last, the latest added first among them. */
function sortPhones(phones) {
  const at = value => typeof value === "number" ? value : -1;
  return [...phones].sort((a, b) => at(b.lastSeenAt) - at(a.lastSeenAt) || at(b.addedAt) - at(a.addedAt)
    || Number(b.primary) - Number(a.primary));
}

/** What "Remove phones not seen for 30 days" takes: what the server marked, never the last phone. */
function stalePhoneList(phones) {
  return phones.length > 1 ? phones.filter(phone => phone.stale === true) : [];
}

/** The last phone always stays, so with one phone there is nothing to remove. */
function canRemovePhones(phones) { return phones.length > 1; }

function collapsible(phones) { return phones.length >= PHONES_COLLAPSE_FROM; }

/** The phones a collapsed list shows; `keep` ids stay visible, such as a row waiting for its answer. */
function visiblePhones(sorted, expanded, keep = []) {
  if (expanded || !collapsible(sorted)) return sorted;
  return sorted.filter((phone, index) => index < PHONES_COLLAPSED || keep.includes(phone.id));
}

/** "1 active now", or "None active now"; the 30-day count has its own line with its action. */
function phoneSummary(phones) {
  const active = phones.filter(phone => phone.status === "seen").length;
  return phones.length === 0 ? "" : active ? `${active} active now` : "None active now";
}

/** The confirmation of a removal, and the arguments remove_phones gets for it. */
function removalIntent(target, phones) {
  if (target === "stale") {
    const count = stalePhoneList(phones).length;
    return {
      kind: "stale", count, args: { notSeenForDays: STALE_DAYS },
      title: `Remove ${plural(count, "phone")} not seen for ${STALE_DAYS} days?`,
      body: `${count === 1 ? "It loses" : "They lose"} access to this computer right away. You'll confirm on your phone `
        + "first; the phone you answer on, and any phone that connects meanwhile, stay paired.",
      confirm: `Remove ${plural(count, "phone")}`,
    };
  }
  const phone = target;
  const inUse = phone.status === "seen" || phone.mostRecent === true;
  return {
    kind: "phone", phone, args: { phoneIds: [phone.id] },
    title: `Remove ${phoneTitle(phone)} from this computer?`,
    body: "It loses access to this computer right away. To use it here again, pair it with a new QR. You'll confirm on "
      + "your phone first."
      + (inUse ? " This is the phone you used last. The phone that answers always stays, so answer on another phone to "
        + "remove this one." : ""),
    confirm: "Remove phone",
  };
}

/** A refusal is written for agents too; the card has already read the list again. */
function personText(text) {
  return text.trim().replace(/\s*Read connection_status again\.?/g, " The list is up to date now; try again.").trim().slice(0, 400);
}

const KEPT = {
  "the person answered on this phone": "it stayed because you answered on it. Answer on another phone to remove it.",
  "it reached this computer while the question was open": "it stayed because it reached this computer while you were asked.",
};

/**
 * What a remove_phones result means for the person: `where` "row" or "section", `tone` "ok", "info" or
 * "error", and whether the list must be read again.
 */
function removalOutcome(result, intent) {
  const text = Array.isArray(result?.content) ? result.content.find(item => item?.type === "text")?.text : undefined;
  if (result?.isError) {
    return { where: "row", tone: "error", refresh: true,
      text: typeof text === "string" && text.trim() ? personText(text) : "GrantTap could not remove it. Refresh and try again." };
  }
  const outcome = result?.structuredContent ?? {};
  const removed = Array.isArray(outcome.removed) ? outcome.removed : [];
  const kept = Array.isArray(outcome.kept) ? outcome.kept : [];
  const remaining = typeof outcome.remaining === "number" ? outcome.remaining : undefined;
  const stay = remaining === undefined ? "" : ` ${plural(remaining, "phone")} ${remaining === 1 ? "stays" : "stay"} paired.`;
  const keptLines = kept.map(phone => `${phoneTitle(phone)}: ${KEPT[phone.reason] ?? `it stayed (${phone.reason}).`}`);
  switch (outcome.status) {
    case "removed":
      if (removed.length === 0) return { where: "row", tone: "info", refresh: true, text: keptLines.join(" ") || "Nothing was removed." };
      return { where: "section", tone: "ok", refresh: true, text: [`Removed ${removed.length === 1 && intent.kind === "phone"
        ? phoneTitle(intent.phone) : plural(removed.length, "phone")}.${stay}`, ...keptLines].join(" ") };
    case "declined": return { where: "row", tone: "info", refresh: false, text: "You said no on your phone, so nothing was removed." };
    case "timed_out": return { where: "row", tone: "info", refresh: false,
      text: "No answer from your phone within 3 minutes, so nothing was removed." };
    case "nothing_to_remove": return { where: "section", tone: "info", refresh: true,
      text: "Nothing to remove: the list had already changed. It is up to date now." };
    default: return { where: "row", tone: "error", refresh: true, text: "Unexpected answer from GrantTap. Refresh to see the current phones." };
  }
}
