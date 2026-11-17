// The Phones section: one row per phone, Remove with a confirmation in its row, the 30-day removal,
// and a long list collapsed. Removal goes through remove_phones, which asks for a yes on a phone; the
// list is read again from connection_status afterwards. Only text is ever inserted, never markup.
let phonesExpanded = false;
/** The removal being confirmed or waited for: a phone id or "stale", and its phase. */
let removal = null;
/** What the last removal said, shown under its row or the 30-day button, by phone id or "stale". */
const phoneNotes = new Map();

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function actionButton(text, className, onClick, focusKey) {
  const node = el("button", className, text);
  node.type = "button";
  node.disabled = busy;
  if (focusKey) node.dataset.focus = focusKey;
  node.addEventListener("click", onClick);
  return node;
}
function phoneIcon(active) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "phone-icon" + (active ? " active" : ""));
  const body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [name, value] of Object.entries({ x: "5", y: "2", width: "10", height: "16", rx: "2.5" })) body.setAttribute(name, value);
  const speaker = document.createElementNS("http://www.w3.org/2000/svg", "path");
  speaker.setAttribute("d", "M8.5 15.2h3");
  svg.append(body, speaker);
  return svg;
}
function focusByKey(key) {
  if (!key) return false;
  const target = [...document.querySelectorAll("[data-focus]")].find(node => node.dataset.focus === key && !node.disabled
    && !node.closest(".hidden"));
  target?.focus();
  return Boolean(target);
}
function announce(text) { $("announce").textContent = text; }

function renderPhones(phones) {
  const focused = document.activeElement?.dataset?.focus;
  const ids = new Set(phones.map(phone => phone.id));
  for (const id of [...phoneNotes.keys()]) {
    if (id === "stale" || ids.has(id)) continue;
    // The phone is gone from the list: what was said about it moves under the list.
    showPhonesMessage(phoneNotes.get(id));
    phoneNotes.delete(id);
  }
  if (removal?.phase === "confirm" && removal.target !== "stale" && !ids.has(removal.target)) removal = null;
  const sorted = sortPhones(phones);
  $("phones-count").textContent = phones.length ? String(phones.length) : "";
  $("phones-summary").textContent = phoneSummary(phones);
  const keep = [removal?.target, ...phoneNotes.keys()].filter(Boolean);
  $("phones").replaceChildren(...visiblePhones(sorted, phonesExpanded, keep).map(phone => phoneRow(phone, phones)));
  show("phones-empty", phones.length === 0);
  show("phones-toggle", collapsible(sorted));
  $("phones-toggle").textContent = phonesExpanded ? "Show fewer" : `Show all ${phones.length} phones`;
  $("phones-toggle").setAttribute("aria-expanded", String(phonesExpanded));
  renderStale(phones);
  show("phones-note", canRemovePhones(phones));
  focusByKey(focused);
}

function phoneRow(phone, phones) {
  const row = el("li", "phone" + (removal?.target === phone.id ? " open" : ""));
  row.dataset.id = phone.id;
  const main = el("div", "phone-main");
  const text = el("div", "phone-text");
  const title = el("div", "phone-title");
  title.append(el("span", "phone-name", phoneTitle(phone)));
  const badge = phoneBadge(phone);
  if (badge) title.append(el("span", `badge ${badge.tone}`, badge.text));
  const detail = el("div", "phone-detail" + (phone.stale ? " faded" : ""), phoneDetail(phone, Date.now()));
  if (typeof phone.lastSeenAt === "number") detail.title = new Date(phone.lastSeenAt).toLocaleString();
  text.append(title, detail);
  main.append(phoneIcon(phone.status === "seen"), text);
  if (canRemovePhones(phones)) {
    const remove = actionButton("Remove", "remove", () => openRemoval(phone.id), `remove:${phone.id}`);
    remove.setAttribute("aria-label", `Remove ${phoneTitle(phone)}`);
    if (removal?.target === phone.id) remove.setAttribute("aria-expanded", "true");
    main.append(remove);
  }
  row.append(main);
  if (removal?.target === phone.id) row.append(removalPanel(removalIntent(phone, phones)));
  if (phoneNotes.has(phone.id)) row.append(noteLine(phoneNotes.get(phone.id)));
  return row;
}

function renderStale(phones) {
  const stale = stalePhoneList(phones);
  const open = removal?.target === "stale";
  show("stale", stale.length > 0 || open || phoneNotes.has("stale"));
  show("remove-stale", stale.length > 0);
  $("stale-text").textContent = stale.length ? `${plural(stale.length, "phone")} not seen for ${STALE_DAYS} days` : "";
  $("remove-stale").textContent = stale.length === 1 ? "Remove it" : `Remove ${stale.length}`;
  $("remove-stale").setAttribute("aria-label", `Remove ${plural(stale.length, "phone")} not seen for ${STALE_DAYS} days`);
  $("remove-stale").setAttribute("aria-expanded", String(open));
  $("stale").querySelectorAll(".confirm, .note").forEach(node => node.remove());
  if (open) $("stale").append(removalPanel(removalIntent("stale", phones)));
  if (phoneNotes.has("stale")) $("stale").append(noteLine(phoneNotes.get("stale")));
}

/** The confirmation in place; while the phone is asked, its buttons give way to a line of the same height. */
function removalPanel(intent) {
  const waiting = removal?.phase === "waiting";
  const panel = el("div", "confirm" + (waiting ? "" : " danger"));
  const id = `removal-${intent.kind === "stale" ? "stale" : intent.phone.label}`;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-labelledby", id);
  const title = el("p", "confirm-title", intent.title);
  title.id = id;
  panel.append(title, el("p", "small", intent.body));
  if (waiting) {
    const wait = el("p", "waiting");
    wait.tabIndex = -1;
    wait.dataset.focus = "removal-waiting";
    wait.append(el("span", "spinner"), el("span", "", "Confirm on your phone. GrantTap sent the question there and waits up to 3 minutes."));
    panel.append(wait);
    return panel;
  }
  const actions = el("div", "actions");
  actions.append(actionButton(intent.confirm, "danger", () => void confirmRemoval(intent), "confirm-removal"),
    actionButton("Cancel", "", cancelRemoval, "cancel-removal"));
  panel.append(actions);
  return panel;
}

function noteLine(note) { return el("p", `note ${note.tone}`, note.text); }

function showPhonesMessage(note) {
  $("phones-message").textContent = note?.text ?? "";
  $("phones-message").className = `note ${note?.tone ?? ""}`;
}

function openRemoval(target) {
  if (busy) return;
  removal = { target, phase: "confirm" };
  phoneNotes.delete(target);
  showPhonesMessage(undefined);
  renderPhones(current.phones || []);
  focusByKey("cancel-removal");
}

function cancelRemoval() {
  const target = removal?.target;
  removal = null;
  renderPhones(current.phones || []);
  focusByKey(`remove:${target}`);
}

async function confirmRemoval(intent) {
  if (!bridgeReady || busy || !removal) return;
  const target = removal.target;
  removal = { target, phase: "waiting" };
  setBusy(true);
  renderPhones(current.phones || []);
  // The buttons that had focus are gone or disabled; the line saying what happens now takes it.
  focusByKey("removal-waiting");
  announce("Confirm on your phone. GrantTap sent the question there.");
  let outcome;
  try {
    outcome = removalOutcome(await callTool("remove_phones", intent.args, REMOVAL_WAIT_MS), intent);
  } catch {
    outcome = { where: "row", tone: "info", refresh: true,
      text: "This card stopped waiting. If you said yes on your phone, the removal went through. The list is up to date now." };
  }
  removal = null;
  setBusy(false);
  if (outcome.where === "section") showPhonesMessage(outcome);
  else phoneNotes.set(target, outcome);
  announce(outcome.text);
  if (outcome.refresh) await call("connection_status");
  else renderPhones(current.phones || []);
  if (!focusByKey(`remove:${target}`)) $("phones-title").focus();
}

/** Called once by view.js, after every script of the card is loaded. */
function bindPhoneControls() {
  $("remove-stale").dataset.focus = "remove:stale";
  $("remove-stale").addEventListener("click", () => openRemoval("stale"));
  $("phones-toggle").dataset.local = "1";
  $("phones-toggle").addEventListener("click", () => {
    phonesExpanded = !phonesExpanded;
    renderPhones(current.phones || []);
  });
  // Escape closes a removal still being confirmed, as Cancel does.
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && removal?.phase === "confirm") { event.preventDefault(); cancelRemoval(); }
  });
}
