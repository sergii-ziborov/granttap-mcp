const $ = id => document.getElementById(id);
const STATUSES = ["disconnected", "paired", "pairing", "expired", "connected"];
let busy = false;
let pairingUri = "";
let current = {};
let pendingMode = "reconnect";
function message(text) { $("message").textContent = text; }
function show(id, visible) { $(id).classList.toggle("hidden", !visible); }
/** While a tool runs nothing else starts; buttons that only change this card (data-local) stay usable. */
function setBusy(value) {
  busy = value;
  document.querySelectorAll("button").forEach(button => { if (!button.dataset.local) button.disabled = value; });
  $("card").setAttribute("aria-busy", String(value));
  renderUpdateSetting();
}
function renderUpdateSetting() {
  const setting = current.runtimeUpdates;
  $("updates-state").textContent = setting ? setting.enabled ? "On" : "Off" : "Unknown";
  $("automatic-updates").setAttribute("aria-checked", String(setting?.enabled === true));
  $("automatic-updates").disabled = busy || !setting || setting.lockedByEnvironment;
  $("updates-detail").textContent = !setting ? "Checking update settings…" : setting.lockedByEnvironment
    ? "Turned off by this computer's service settings."
    : "Checks hourly and installs when this computer is free.";
}
/** A waiting update in a line of the card's own; the server's fuller sentence is its tooltip. */
function updateLine(pending, settings) {
  if (!pending?.version) return "";
  if (pending.state === "selected") return "Installed. Coding apps use it from their next start.";
  if (settings?.enabled === false) return "Downloaded, but automatic updates are off.";
  if (pending.hold?.phase === "holding" || pending.hold?.phase === "handing-over") {
    return "Installing: new phone messages wait while running work ends, 10 min at most.";
  }
  return "Downloaded. Installs when running work ends.";
}
function renderVersion(state) {
  $("version").textContent = state.version || "Unknown";
  const pending = state.pendingUpdate;
  $("update-badge").textContent = pending?.version ? `${pending.version} waiting` : "";
  show("update-badge", Boolean(pending?.version));
  show("update-none", Boolean(state.version) && !pending?.version);
  $("update-detail").textContent = updateLine(pending, state.runtimeUpdates);
  $("update-detail").title = pending?.detail || "";
  show("update-detail", Boolean(pending?.version));
}
function clearCode() {
  pairingUri = "";
  $("qr").removeAttribute("src");
  show("qr", false);
  show("copy", false);
}
function statusText(state) {
  const blocked = accountBlockedText(state);
  if (blocked) return blocked;
  const phones = state.phones || [];
  const active = phones.filter(phone => phone.status === "seen");
  if (state.status === "connected") {
    return `Connected · ${active.length === 1 ? `${phoneTitle(active[0])} is active now` : `${active.length} phones active now`}`;
  }
  if (state.status === "paired") {
    return typeof state.phoneLastSeenAt === "number"
      ? `Paired · last phone activity ${relativeAge(Date.now() - state.phoneLastSeenAt)}` : "Paired · no phone has connected yet";
  }
  return { disconnected: "Not paired", pairing: "Waiting for a phone to scan the QR", expired: "QR expired" }[state.status];
}
function render(value) {
  const result = value?.mcp_tool_result ?? value?.call_tool_result ?? value;
  const state = result?.structuredContent ?? result?.structured_content;
  if (!STATUSES.includes(state?.status) || result.isError) return;
  current = state;
  renderUpdateSetting();
  clearCode();
  const meta = result._meta?.granttap ?? {};
  renderAccount(state, meta);
  const account = accountOf(state);
  const pairingText = {
    disconnected: signedIn(account)
      ? ["Open GrantTap on your iPhone", "When the iPhone is signed in to the same GrantTap account, it links this computer by itself. A QR is only needed if it doesn't."]
      : ["Connect a phone", "Sign this computer in with your GrantTap passkey, then open GrantTap on your iPhone signed in to the same account. A one-time QR is the fallback."],
    pairing: ["Scan this QR", "Open GrantTap on the phone and scan it. Keep this card open; the QR is only here, never in chat."],
    expired: ["QR expired", "Create a new QR when you are ready. The saved pairing stays."],
  }[state.status];
  const paired = state.status !== "disconnected";
  const blocked = Boolean(accountBlockedText(state));
  $("card").className = "card " + (blocked ? "attention" : state.status === "connected" ? "connected"
    : paired && state.status !== "expired" ? "paired" : "attention");
  $("status").textContent = statusText(state);
  show("pairing", Boolean(pairingText));
  if (pairingText) [$("heading").textContent, $("detail").textContent] = pairingText;
  // Signed in, connect would only say to open the phone: the button offers the QR fallback itself.
  $("connect").textContent = signedIn(account) ? "Show a QR instead" : "Add a phone";
  $("connect").dataset.qr = signedIn(account) ? "1" : "";
  show("connect", state.status === "disconnected");
  show("new-qr", state.status === "expired");
  show("actions-section", paired);
  show("phones-section", paired || (state.phones || []).length > 0);
  hideConfirm();
  if (state.status === "pairing" && state.expiresAt > Date.now()) {
    if (/^granttap:\/\/pair-v2\?/.test(meta.pairingUri || "")) pairingUri = meta.pairingUri;
    if (/^data:image\/png;base64,/.test(meta.qrDataUrl || "")) {
      $("qr").src = meta.qrDataUrl;
      show("qr", true);
    }
    show("copy", Boolean(pairingUri));
  }
  $("computer").textContent = state.computer || "Unknown";
  renderVersion(state);
  $("relay").textContent = (state.relay || "Not configured") + " · " + (state.relayStatus || "unknown");
  $("phone").textContent = state.phoneLastSeenAt ? new Date(state.phoneLastSeenAt).toLocaleString() : "Not observed by this chat";
  $("providers").replaceChildren(...(state.providers || []).map(provider => {
    const row = document.createElement("li");
    row.textContent = `${provider.id}: ${provider.detail}`;
    return row;
  }));
  renderPhones(state.phones || []);
  updateExpiry();
}
function updateExpiry() {
  const remaining = Math.ceil((current.expiresAt - Date.now()) / 1000);
  $("expiry").textContent = current.status === "pairing" && remaining > 0
    ? `One-time code expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "";
  if (current.status === "pairing" && remaining <= 0) {
    clearCode();
    $("status").textContent = "QR expired";
    $("heading").textContent = "Create a new QR";
    $("detail").textContent = "The previous code expired. Tap Create a new QR when you want another attempt. GrantTap will not make one by itself.";
    show("new-qr", true);
    show("connect", false);
  }
}
/** A confirmation under the buttons that asked for it; Cancel is focused, so Return never confirms by accident. */
function askToConfirm(mode, text, label, anchor) {
  pendingMode = mode;
  $("confirm-copy").textContent = text;
  $("confirm-reconnect").textContent = label;
  anchor.after($("confirm"));
  show("confirm", true);
  $("cancel").focus();
}
function hideConfirm() { show("confirm", false); }
async function call(name, args = {}) {
  if (!bridgeReady || busy) return;
  setBusy(true);
  message("Checking…");
  try {
    const result = await callTool(name, args);
    if (result?.isError) message("Could not complete the request. Refresh status before retrying.");
    else { render(result); message(""); }
    return result;
  } catch {
    message("No successful response. Refresh status before retrying.");
  } finally {
    setBusy(false);
  }
}
$("connect").addEventListener("click", () => $("connect").dataset.qr
  ? call("reconnect", { confirmed: true, mode: "reconnect" }) : call("connect"));
$("add-device").addEventListener("click", () => askToConfirm("add_device",
  "Show a one-time QR for another phone or iPad. It gets its own key; phones already paired keep working.", "Show QR",
  $("pairing-tools")));
$("reconnect").addEventListener("click", () => askToConfirm("reconnect",
  "Show a one-time QR that gives this computer's pairing back to a phone that lost it. Phones already paired keep working.",
  "Show QR", $("pairing-tools")));
$("new-qr").addEventListener("click", () => askToConfirm(pendingMode,
  "Create a new one-time QR for the same action. The saved pairing stays.", "Create QR", $("pairing-actions")));
$("cancel").addEventListener("click", hideConfirm);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("confirm").classList.contains("hidden")) { event.preventDefault(); hideConfirm(); }
});
$("confirm-reconnect").addEventListener("click", () => {
  hideConfirm();
  call("reconnect", { confirmed: true, mode: pendingMode });
});
$("unpair").addEventListener("click", () => {
  const open = $("unpair-help").classList.contains("hidden");
  show("unpair-help", open);
  $("unpair").setAttribute("aria-expanded", String(open));
});
$("unpair").dataset.local = "1";
$("copy-reset").dataset.local = "1";
$("copy-reset").addEventListener("click", () => copyText("granttap reset", "Command copied. Paste it in Terminal on this computer."));
$("refresh").addEventListener("click", () => call("connection_status"));
$("automatic-updates").addEventListener("click", () => call("set_runtime_auto_update", { enabled: !current.runtimeUpdates.enabled }));
$("sign-in").addEventListener("click", () => call("sign_in"));
$("copy").addEventListener("click", () => {
  updateExpiry();
  if (pairingUri) void copyText(pairingUri, "Pairing link copied.");
});
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); message(done); }
  catch { message(text === pairingUri ? "Clipboard is unavailable. Scan the QR instead." : "Clipboard is unavailable. Type the command instead."); }
}
bindPhoneControls();
render({ structuredContent: window.openai?.toolOutput, _meta: window.openai?.toolResponseMetadata });
setBusy(true);
void initializeBridge();
setInterval(updateExpiry, 1000);
setInterval(() => {
  if (!document.hidden && !busy && current.status === "pairing" && current.expiresAt > Date.now()) void call("connection_status");
}, 5000);

if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (bridgeReady && !legacyBridge) post({
      method: "ui/notifications/size-changed",
      // The content's own box: scrollHeight never drops below the frame, so the card could only grow.
      params: { width: Math.ceil(document.documentElement.getBoundingClientRect().width),
        height: Math.ceil(document.documentElement.getBoundingClientRect().height) },
    });
  }).observe(document.body);
}
