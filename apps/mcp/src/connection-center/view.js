const $ = id => document.getElementById(id);
let busy = false;
let pairingUri = "";
let current = {};
let pendingMode = "reconnect";
function message(text) { $("message").textContent = text; }
function setBusy(value) {
  busy = value;
  document.querySelectorAll("button").forEach(button => { button.disabled = value; });
}
function clearCode() {
  pairingUri = "";
  $("qr").removeAttribute("src");
  $("qr").classList.add("hidden");
  $("copy").classList.add("hidden");
}
function render(value) {
  const result = value?.mcp_tool_result ?? value?.call_tool_result ?? value;
  const state = result?.structuredContent ?? result?.structured_content;
  if (!state?.status || result.isError) return;
  current = state;
  clearCode();
  const meta = result._meta?.granttap ?? {};
  const labels = {
    disconnected: ["Not paired", "Add a device", "Tap Add a device. Scan the QR in GrantTap on iPhone, iPad, or Android."],
    pairing: ["Waiting for a device", "Scan this QR", "Keep this card open. The QR is only here — not in chat."],
    expired: ["QR expired", "Add a device again", "Tap Add a device for a new QR in this same room."],
    paired: ["Saved pairing", "Saved pairing", "This Mac has one saved pairing slot. That is not a registry of every device in the room, and a Mesh link is a different membership."],
    connected: ["Last confirmed activity", "Saved pairing", "GrantTap confirmed activity on the saved pairing. A shared room is not a shared Project."],
  };
  const [status, heading, detail] = labels[state.status] || labels.disconnected;
  const hasPhone = (state.phones || []).length > 0 || state.status === "paired" || state.status === "connected";
  $("card").className = "card " + (state.status === "connected" ? "connected" : "");
  $("status").textContent = status;
  $("heading").textContent = heading;
  $("detail").textContent = detail;
  $("confirm").classList.add("hidden");
  $("connect").textContent = hasPhone ? "Add another device" : "Add a device";
  $("connect").classList.toggle("hidden", state.status === "pairing");
  $("reconnect").classList.toggle("hidden", state.status === "pairing" || state.status === "disconnected");
  $("new-qr")?.classList.toggle("hidden", state.status !== "expired");
  $("phones").replaceChildren();
  for (const phone of state.phones || []) {
    const row = document.createElement("li");
    const when = phone.lastSeenAt ? new Date(phone.lastSeenAt).toLocaleString() : "saved on this Mac";
    row.textContent = `${phone.name} · ${phone.status === "seen" ? "last confirmed activity just now" : "saved pairing"} · ${when}`;
    $("phones").append(row);
  }
  $("phones-empty").classList.toggle("hidden", (state.phones || []).length > 0);
  if (state.status === "pairing" && state.expiresAt > Date.now()) {
    if (/^granttap:\/\/pair-v2\?/.test(meta.pairingUri || "")) pairingUri = meta.pairingUri;
    if (/^data:image\/png;base64,/.test(meta.qrDataUrl || "")) {
      $("qr").src = meta.qrDataUrl;
      $("qr").classList.remove("hidden");
    }
    $("copy").classList.toggle("hidden", !pairingUri);
  }
  $("computer").textContent = state.computer || "Unknown";
  $("version").textContent = state.version || "Unknown";
  $("relay").textContent = (state.relay || "Not configured") + " · " + (state.relayStatus || "unknown");
  $("phone").textContent = state.phoneLastSeenAt ? new Date(state.phoneLastSeenAt).toLocaleString() : "Not observed by this MCP";
  $("providers").replaceChildren();
  for (const provider of state.providers || []) {
    const row = document.createElement("li");
    row.textContent = `${provider.id}: ${provider.detail}`;
    $("providers").append(row);
  }
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
    $("detail").textContent = "The previous code expired. Tap Create a new QR when you want another attempt. GrantTap will not mint one from this timer.";
    $("new-qr")?.classList.remove("hidden");
    $("connect").classList.add("hidden");
  }
}
$("connect").addEventListener("click", () => {
  if (current.status && current.status !== "disconnected") {
    pendingMode = "add_device";
    $("confirm-copy").textContent = "Add another controller device with its own encryption key. Scan this computer’s QR in GrantTap on the new phone.";
    $("confirm").classList.remove("hidden");
    $("cancel").focus();
    return;
  }
  call("connect");
});
$("refresh").addEventListener("click", () => call("connection_status"));
$("reconnect").addEventListener("click", () => {
  pendingMode = "reconnect";
  $("confirm-copy").textContent = "Reconnect shows a new QR for the existing controller device in this room.";
  $("confirm").classList.remove("hidden");
  $("cancel").focus();
});
$("cancel").addEventListener("click", () => $("confirm").classList.add("hidden"));
$("confirm-reconnect").addEventListener("click", () => {
  $("confirm").classList.add("hidden");
  call("reconnect", { confirmed: true, mode: pendingMode });
});
$("new-qr")?.addEventListener("click", () => {
  $("confirm-copy").textContent = "Create a new QR for the selected device action. The saved pairing stays.";
  $("confirm").classList.remove("hidden");
  $("cancel").focus();
});
$("copy").addEventListener("click", async () => {
  updateExpiry();
  if (!pairingUri) return;
  try { await navigator.clipboard.writeText(pairingUri); message("Pairing link copied."); }
  catch { message("Clipboard is unavailable. Scan the QR instead."); }
});
render({ structuredContent: window.openai?.toolOutput, _meta: window.openai?.toolResponseMetadata });
setBusy(true);
void initializeBridge();
setInterval(updateExpiry, 1000);
setInterval(() => {
  if (!document.hidden && current.status === "pairing" && current.expiresAt > Date.now()) void call("connection_status");
}, 5000);

if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    if (bridgeReady && !legacyBridge) post({
      method: "ui/notifications/size-changed",
      params: { height: document.documentElement.scrollHeight },
    });
  }).observe(document.body);
}
