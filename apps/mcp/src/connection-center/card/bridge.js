// MCP Apps bridge. Pairing secrets stay in this iframe; never persist UI state.
const CALL_WAIT_MS = 20_000;
let nextId = 0;
const requests = new Map();
let hostOrigin = null;
let bridgeReady = false;
let legacyBridge = false;
function post(message) {
  window.parent.postMessage({ jsonrpc: "2.0", ...message }, hostOrigin || "*");
}
function request(method, params, waitMs = CALL_WAIT_MS) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error("No response. Refresh status before retrying."));
    }, waitMs);
    requests.set(id, { resolve, reject, timer });
    post({ id, method, params });
  });
}
// The host's theme and style variables (MCP Apps hostContext). Only custom properties are taken, one by one.
function applyHostContext(context) {
  if (!context || typeof context !== "object") return;
  const root = document.documentElement;
  if (context.theme === "light" || context.theme === "dark") {
    root.dataset.theme = context.theme;
    root.style.colorScheme = context.theme;
  }
  const variables = context.styles?.variables;
  if (variables && typeof variables === "object") {
    for (const [name, value] of Object.entries(variables)) {
      if (/^--[a-z0-9-]{1,64}$/.test(name) && typeof value === "string" && value.length <= 300) root.style.setProperty(name, value);
    }
  }
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
  } else if (data.method === "ui/notifications/host-context-changed") {
    applyHostContext(data.params);
  }
});
async function initializeBridge() {
  try {
    const initialized = await request("ui/initialize", {
      appInfo: { name: "GrantTap connection center", version: "3.0.0" },
      appCapabilities: {}, protocolVersion: "2026-01-26",
    });
    if (initialized?.protocolVersion !== "2026-01-26") throw new Error("Unsupported UI protocol");
    applyHostContext(initialized.hostContext);
    post({ method: "ui/notifications/initialized" });
    // The compatibility API is an explicit tool-call capability. In Codex it
    // avoids an iframe proxy that can initialize but time out on tools/call.
    legacyBridge = typeof window.openai?.callTool === "function";
    if (!legacyBridge && !initialized.hostCapabilities?.serverTools) {
      message("This host cannot call GrantTap tools from the card. Ask the agent to open connection status or add a device.");
      return;
    }
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
/** One GrantTap tool call through the host; rejects when no answer came within `waitMs`. */
async function callTool(name, args = {}, waitMs = CALL_WAIT_MS) {
  if (!legacyBridge) return request("tools/call", { name, arguments: args }, waitMs);
  let timer;
  try {
    return await Promise.race([
      window.openai.callTool(name, args),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No response")), waitMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
