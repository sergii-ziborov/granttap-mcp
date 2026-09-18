import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";

const asset = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
async function fixture(t: { after: (fn: () => void) => void }, silent = false) {
  const dom = new JSDOM(asset("widget.html"), { runScripts: "outside-only", url: "https://widget.example" });
  t.after(() => dom.window.close());
  const window = dom.window;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  window.setTimeout = ((fn: () => void) => { timers.set(++timerId, fn); return timerId; }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof window.clearTimeout;
  const intervals: Array<() => void> = [];
  window.setInterval = ((fn: () => void) => { intervals.push(fn); return intervals.length; }) as typeof window.setInterval;
  let onResize = () => {};
  Object.defineProperty(window, "ResizeObserver", { value: class {
    constructor(fn: () => void) { onResize = fn; }
    observe() { onResize(); }
  } });
  const notifications: string[] = [];
  let failure = false;
  const calls: Array<{ name: string; arguments: unknown }> = [];
  let state: Record<string, unknown> = { status: "disconnected", providers: [] };
  let meta: Record<string, unknown> = {};
  window.postMessage = ((data: { id?: number; method: string; params: { name: string; arguments: unknown } }) => {
    if (data.id === undefined) { notifications.push(data.method); return; }
    if (silent) return;
    let result;
    if (data.method === "ui/initialize") result = { protocolVersion: "2026-01-26" };
    else { calls.push(data.params); result = { structuredContent: state, _meta: { granttap: meta } }; }
    queueMicrotask(() => window.dispatchEvent(new window.MessageEvent("message", {
      source: window as unknown as Window, origin: "https://host.example", data: failure ? { jsonrpc: "2.0", id: data.id, error: { message: "failed" } } : { jsonrpc: "2.0", id: data.id, result },
    })));
  }) as typeof window.postMessage;
  for (const name of ["bridge.js", "view.js"]) {
    new Script(asset(name), { filename: fileURLToPath(new URL(`../${name}`, import.meta.url)) })
      .runInContext(dom.getInternalVMContext());
  }
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  await settle();
  const button = (id: string) => window.document.getElementById(id) as unknown as { click(): void };
  const el = (id: string) => window.document.getElementById(id)!;
  return { window, calls, el, button, settle, notifications, resize: () => onResize(), poll: () => intervals.forEach(fn => fn()), fail: () => { failure = true; }, timeout: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); }, set: (next: Record<string, unknown>, nextMeta = {}) => { state = next; meta = nextMeta; } };
}

test("widget initializes, checks status, and requires explicit reconnect confirmation", async (t) => {
  const ui = await fixture(t);
  assert.deepEqual(ui.calls.map(x => x.name), ["connection_status"]);
  assert.equal(ui.el("status").textContent, "Not paired");
  assert.equal(ui.el("connect").textContent, "Add a device");
  ui.button("connect").click();
  await ui.settle();
  assert.equal(ui.calls.at(-1)?.name, "connect");
  ui.set({ status: "paired", phones: [{ name: "iPhone", status: "paired", lastSeenAt: null }], providers: [] });
  ui.button("refresh").click();
  await ui.settle();
  assert.match(ui.el("phones").textContent || "", /iPhone/);
  assert.equal(ui.el("connect").textContent, "Add another device");
  assert.equal(ui.el("reconnect").classList.contains("hidden"), false);
  ui.button("connect").click();
  assert.equal(ui.el("confirm").classList.contains("hidden"), false);
  ui.button("cancel").click();
  assert.equal(ui.el("confirm").classList.contains("hidden"), true);
  ui.button("reconnect").click();
  ui.button("cancel").click();
  assert.equal(ui.calls.length, 3);
  ui.button("reconnect").click();
  ui.button("confirm-reconnect").click();
  await ui.settle();
  assert.equal(ui.calls.at(-1)?.name, "reconnect");
  assert.equal((ui.calls.at(-1)?.arguments as { confirmed: boolean }).confirmed, true);
});

test("widget clears secrets when paired or expired and ignores foreign messages", async (t) => {
  const ui = await fixture(t);
  const pairing = { status: "pairing", expiresAt: Date.now() + 60000, providers: [] };
  const secret = { pairingUri: "granttap://pair-v2?fixture", qrDataUrl: "data:image/png;base64,AA==" };
  ui.set(pairing, secret);
  ui.button("refresh").click();
  await ui.settle();
  assert.equal(ui.el("qr").getAttribute("src"), secret.qrDataUrl);
  ui.window.dispatchEvent(new ui.window.MessageEvent("message", {
    source: null, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { status: "connected" } } },
  }));
  assert.equal(ui.el("status").textContent, "Waiting for a device");
  ui.set({ status: "paired", providers: [{ id: "codex", detail: "<script>attack</script>" }] });
  ui.button("refresh").click();
  await ui.settle();
  assert.equal(ui.el("qr").hasAttribute("src"), false);
  assert.equal(ui.el("copy").classList.contains("hidden"), true);
  assert.equal(ui.el("providers").querySelector("script"), null);
  ui.set({ ...pairing, expiresAt: Date.now() - 1 }, secret);
  ui.button("refresh").click();
  await ui.settle();
  assert.equal(ui.el("status").textContent, "QR expired");
  assert.equal(ui.el("qr").hasAttribute("src"), false);
  const before = ui.calls.length;
  ui.poll();
  assert.equal(ui.calls.some((item) => item.name === "reconnect"), false);
  assert.equal(ui.calls.length, before);
  assert.equal(ui.el("new-qr").classList.contains("hidden"), false);
});


test("host errors restore controls and unavailable hosts provide a usable fallback", async (t) => {
  const ui = await fixture(t);
  ui.fail();
  ui.button("refresh").click();
  await ui.settle();
  assert.match(ui.el("message").textContent || "", /Refresh status before retrying/);
  assert.equal(ui.el("refresh").hasAttribute("disabled"), false);
  const missing = await fixture(t, true);
  missing.timeout();
  await missing.settle();
  assert.match(missing.el("message").textContent || "", /Interactive controls are unavailable/);
  assert.equal(missing.calls.length, 0);
});

test("legacy hosts can use the same controls; clipboard failures give QR fallback", async (t) => {
  const ui = await fixture(t, true);
  const legacyCalls: string[] = [];
  Object.defineProperty(ui.window, "openai", { value: { callTool: async (name: string) => {
    legacyCalls.push(name);
    return { structuredContent: { status: "pairing", expiresAt: Date.now() + 60000 },
      _meta: { granttap: { pairingUri: "granttap://pair-v2?fixture", qrDataUrl: "data:image/png;base64,AA==" } } };
  } } });
  ui.timeout();
  await ui.settle();
  assert.deepEqual(legacyCalls, ["connection_status"]);
  ui.button("copy").click();
  await ui.settle();
  assert.match(ui.el("message").textContent || "", /Clipboard is unavailable/);
  let copied = "";
  Object.defineProperty(ui.window.navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text; } } });
  ui.button("copy").click();
  await ui.settle();
  assert.equal(copied, "granttap://pair-v2?fixture");
  assert.match(ui.el("message").textContent || "", /Pairing link copied/);
});


test("pending pairing refreshes while visible and host notifications update the card", async (t) => {
  const ui = await fixture(t);
  Object.defineProperty(ui.window.document, "hidden", { value: false });
  ui.set({ status: "pairing", expiresAt: Date.now() + 60000 });
  ui.button("refresh").click();
  await ui.settle();
  const count = ui.calls.length;
  ui.poll();
  await ui.settle();
  assert.equal(ui.calls.length, count + 1);
  ui.resize();
  assert.equal(ui.notifications.at(-1), "ui/notifications/size-changed");
  const notify = (method: string, params?: object, origin = "https://host.example") => ui.window.dispatchEvent(new ui.window.MessageEvent("message", {
    source: ui.window as unknown as Window, origin, data: { jsonrpc: "2.0", method, params },
  }));
  notify("ui/notifications/tool-result", { structuredContent: { status: "connected", phoneLastSeenAt: Date.now() } }, "https://foreign.example");
  assert.equal(ui.el("status").textContent, "Waiting for a device");
  notify("ui/notifications/tool-result", { structuredContent: { status: "connected", phoneLastSeenAt: Date.now(), phones: [{ name: "iPhone", status: "seen", lastSeenAt: Date.now() }] } });
  assert.equal(ui.el("status").textContent, "Last confirmed activity");
  assert.match(ui.el("phones").textContent || "", /iPhone/);
  assert.equal(ui.el("phones-empty").classList.contains("hidden"), true);
  const connectedCount = ui.calls.length;
  ui.poll();
  assert.equal(ui.calls.length, connectedCount);
  notify("ui/notifications/tool-cancelled");
  assert.match(ui.el("message").textContent || "", /Request cancelled/);
});
