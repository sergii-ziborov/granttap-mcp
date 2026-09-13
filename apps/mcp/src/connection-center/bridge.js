// MCP Apps bridge. Pairing secrets stay in this iframe; never persist UI state.
let nextId = 0;
const requests = new Map();
let hostOrigin = null;
let bridgeReady = false;
let legacyBridge = false;
function post(message) {
  window.parent.postMessage({ jsonrpc: "2.0", ...message }, hostOrigin || "*");
}
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error("No response. Refresh status before retrying."));
    }, 20000);
    requests.set(id, { resolve, reject, timer });
    post({ id, method, params });
  });
}
window.addEventListener("message", event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
  if (hostOrigin && event.origin !== hostOrigin) return;
  const data = event.data;
  const pending = requests.get(data.id);
  if (pending) {
    if (event.origin && event.origin !== "null") hostOrigin = event.origin;
    requests.delete(data.id);
    clearTimeout(pending.timer);
    if (data.error) pending.reject(new Error("The host could not complete this request."));
    else pending.resolve(data.result);
  } else if (data.method === "ui/notifications/tool-result") {
    render(data.params);
  } else if (data.method === "ui/notifications/tool-cancelled") {
    message("Request cancelled. Refresh status to check the current state.");
  }
});
async function initializeBridge() {
  try {
    const initialized = await request("ui/initialize", {
      appInfo: { name: "GrantTap connection center", version: "2.0.0" },
      appCapabilities: {}, protocolVersion: "2026-01-26",
    });
    if (initialized?.protocolVersion !== "2026-01-26") throw new Error("Unsupported UI protocol");
    post({ method: "ui/notifications/initialized" });
    bridgeReady = true;
  } catch {
    if (!window.openai?.callTool) {
      message("Interactive controls are unavailable. Ask GrantTap to check connection status or show your pairing QR.");
      return;
    }
    legacyBridge = true;
    bridgeReady = true;
  }
  setBusy(false);
  await call("connection_status");
}
async function call(name, args = {}) {
  if (!bridgeReady || busy) return;
  setBusy(true);
  message("Checking…");
  try {
    const result = legacyBridge
      ? await legacyCall(name, args)
      : await request("tools/call", { name, arguments: args });
    if (result?.isError) message("Could not complete the request. Refresh status and check the relay before retrying.");
    else { render(result); message("Status updated."); }
  } catch {
    message("No successful response. Refresh status before retrying; pairing may already have changed.");
  } finally {
    setBusy(false);
  }
}

async function legacyCall(name, args) {
  let timer;
  try {
    return await Promise.race([
      window.openai.callTool(name, args),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No response")), 20000); }),
    ]);
  } finally { clearTimeout(timer); }
}
