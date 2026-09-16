const $ = id => document.getElementById(id);
let busy = false;
let pairingUri = "";
let current = {};
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
    disconnected: ["Not paired", "Add your iPhone", "Tap Add iPhone. Scan the QR in GrantTap → Settings → Connections."],
    pairing: ["Waiting for iPhone", "Scan this QR", "Keep this card open. The QR is only here — not in chat."],
    expired: ["QR expired", "Add iPhone again", "Tap Add iPhone to replace the expired code."],
    paired: ["iPhone saved", "Phones on this computer", "A pairing is saved. Open GrantTap on the phone, or tap Add iPhone for a new QR."],
    connected: ["iPhone seen", "Phones on this computer", "GrantTap received a recent message from the phone."],
  };
  const [status, heading, detail] = labels[state.status] || labels.disconnected;
  $("card").className = "card " + (state.status === "connected" ? "connected" : "");
  $("status").textContent = status;
  $("heading").textContent = heading;
  $("detail").textContent = detail;
  $("confirm").classList.add("hidden");
  $("connect").classList.toggle("hidden", state.status === "pairing");
  $("reconnect").classList.add("hidden");
  $("phones").replaceChildren();
  for (const phone of state.phones || []) {
    const row = document.createElement("li");
    const when = phone.lastSeenAt ? new Date(phone.lastSeenAt).toLocaleString() : "saved on this Mac";
    row.textContent = `${phone.name} · ${phone.status === "seen" ? "online just now" : "paired"} · ${when}`;
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
    $("detail").textContent = "Tap Add iPhone to replace the expired code.";
    $("connect").classList.remove("hidden");
  }
}
$("connect").addEventListener("click", () => {
  if (current.status && current.status !== "disconnected") {
    $("confirm").classList.remove("hidden");
    $("cancel").focus();
    return;
  }
  call("connect");
});
$("refresh").addEventListener("click", () => call("connection_status"));
$("reconnect").addEventListener("click", () => {
  $("confirm").classList.remove("hidden");
  $("cancel").focus();
});
$("cancel").addEventListener("click", () => $("confirm").classList.add("hidden"));
$("confirm-reconnect").addEventListener("click", () => {
  $("confirm").classList.add("hidden");
  call("reconnect", { confirmed: true });
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
