import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { CARD_SCRIPTS, connectionCardHtml } from "../../mcp-tools/connect/widget";

const asset = (name: string) => readFileSync(new URL(`../card/${name}`, import.meta.url), "utf8");
const NOW = Date.now();
const DAY = 86_400_000;
type Phone = { id: string; label: string; name: string; primary: boolean; status: "paired" | "seen";
  lastSeenAt: number | null; addedAt: number | null; mostRecent: boolean; stale: boolean };
const phone = (n: number, extra: Partial<Phone> = {}): Phone => {
  const id = n.toString(16).padStart(6, "0") + "f".repeat(58);
  return { id, label: id.slice(0, 6), name: `Phone ${id.slice(0, 6)}`, primary: false, status: "paired",
    lastSeenAt: null, addedAt: null, mostRecent: false, stale: false, ...extra };
};
/** Arrays made inside the script's own context have another Array prototype; compare plain copies. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const live = phone(1, { name: "iPhone", primary: true, status: "seen", lastSeenAt: NOW - 20_000, mostRecent: true });
const old = (n: number) => phone(n, { lastSeenAt: NOW - (40 + n) * DAY, stale: true });

/** The pure rules of phones.js, without a DOM. */
function rules() {
  const context = createContext({});
  new Script(asset("phones.js"), { filename: fileURLToPath(new URL("../card/phones.js", import.meta.url)) }).runInContext(context);
  return new Script(`({ relativeAge, phoneTitle, phoneDetail, phoneBadge, sortPhones, stalePhoneList, canRemovePhones,
    visiblePhones, collapsible, phoneSummary, removalIntent, removalOutcome, REMOVAL_WAIT_MS })`).runInContext(context);
}

test("rows read like the phone app: names, last seen, Never seen, badges and the label once", () => {
  const r = rules();
  assert.deepEqual([0, 59_000, 5 * 60_000, 3 * 3_600_000, DAY, 40 * DAY, 95 * DAY, 800 * DAY].map(ms => r.relativeAge(ms)),
    ["just now", "just now", "5 min ago", "3 h ago", "1 day ago", "40 days ago", "3 months ago", "2 years ago"]);
  assert.equal(r.phoneTitle(phone(2, { name: "" })), "Phone 000002");
  assert.equal(r.phoneTitle(phone(3, { name: "", primary: true })), "First pairing");
  assert.equal(r.phoneDetail(live, NOW), "Last seen just now · first pairing · 000001");
  assert.equal(r.phoneDetail(phone(4), NOW), "Never seen", "an unnamed phone's label is already in its name");
  assert.equal(r.phoneDetail(phone(5, { addedAt: NOW - 2 * 60_000 }), NOW), "Never seen · added 2 min ago");
  assert.deepEqual({ ...r.phoneBadge(live) }, { text: "Active now", tone: "ok" });
  assert.deepEqual({ ...r.phoneBadge({ ...live, status: "paired" }) }, { text: "Last active", tone: "neutral" });
  assert.equal(r.phoneBadge(old(6)), undefined);
});

test("the list sorts most recent first, collapses past seven phones, and keeps a busy row visible", () => {
  const r = rules();
  const phones = [phone(9), old(8), live, old(2), phone(7, { addedAt: NOW - DAY })];
  assert.deepEqual(plain(r.sortPhones(phones).map((p: Phone) => p.label)), ["000001", "000002", "000008", "000007", "000009"]);
  const many = r.sortPhones([live, ...Array.from({ length: 16 }, (_, i) => old(i + 2))]);
  assert.equal(r.collapsible(many), true);
  assert.equal(r.collapsible(many.slice(0, 7)), false);
  assert.equal(r.visiblePhones(many, false).length, 5);
  assert.equal(r.visiblePhones(many, true).length, 17);
  assert.deepEqual(r.visiblePhones(many, false, [many[12].id]).map((p: Phone) => p.id).at(-1), many[12].id);
  assert.equal(r.phoneSummary(many), "1 active now");
  assert.equal(r.phoneSummary([old(2), old(3)]), "None active now");
});

test("the 30-day removal takes what the server marked stale, and the last phone always stays", () => {
  const r = rules();
  const phones = [live, old(2), old(3), phone(4, { lastSeenAt: NOW - 2 * DAY })];
  assert.deepEqual(plain(r.stalePhoneList(phones).map((p: Phone) => p.label)), ["000002", "000003"]);
  assert.deepEqual(plain(r.stalePhoneList([{ ...old(2), stale: true }])), [], "the only phone is never offered for removal");
  assert.equal(r.canRemovePhones([live]), false);
  assert.equal(r.canRemovePhones(phones), true);
  const stale = r.removalIntent("stale", phones);
  assert.deepEqual({ ...stale.args }, { notSeenForDays: 30 });
  assert.equal(stale.title, "Remove 2 phones not seen for 30 days?");
  assert.equal(stale.confirm, "Remove 2 phones");
  const one = r.removalIntent(old(2), phones);
  assert.deepEqual([...one.args.phoneIds], [old(2).id]);
  assert.doesNotMatch(one.body, /phone you used last/);
  assert.match(r.removalIntent(live, phones).body, /answer on another phone to remove this one/);
  assert.ok(r.REMOVAL_WAIT_MS > 180_000, "the card waits longer than the yes on the phone can take");
});

test("each remove_phones answer says what happened, where, and whether the list is read again", () => {
  const r = rules();
  const intent = r.removalIntent(old(2), [live, old(2)]);
  const removed = r.removalOutcome({ structuredContent: { status: "removed", removed: [old(2)], kept: [], remaining: 1 } }, intent);
  assert.deepEqual({ ...removed }, { where: "section", tone: "ok", refresh: true, text: "Removed Phone 000002. 1 phone stays paired." });
  const kept = r.removalOutcome({ structuredContent: { status: "removed", removed: [], remaining: 2,
    kept: [{ ...old(2), reason: "the person answered on this phone" }] } }, intent);
  assert.equal(kept.where, "row");
  assert.match(kept.text, /stayed because you answered on it/);
  assert.match(r.removalOutcome({ structuredContent: { status: "declined" } }, intent).text, /said no/);
  assert.equal(r.removalOutcome({ structuredContent: { status: "timed_out" } }, intent).refresh, false);
  const refused = r.removalOutcome({ isError: true, content: [{ type: "text",
    text: "This computer's pairing changed. Read connection_status again." }] }, intent);
  assert.deepEqual({ ...refused }, { where: "row", tone: "error", refresh: true,
    text: "This computer's pairing changed. The list is up to date now; try again." });
  assert.equal(r.removalOutcome({ structuredContent: { status: "nothing_to_remove" } }, intent).where, "section");
  assert.equal(r.removalOutcome({ structuredContent: { status: "surprise" } }, intent).tone, "error");
});

/** The card in a DOM with a host that answers tool calls; `answer` decides remove_phones. */
async function card(t: TestContext, phones: Phone[], answer: (args: unknown) => unknown = () => undefined) {
  const dom = new JSDOM(asset("widget.html"), { runScripts: "outside-only", url: "https://widget.example" });
  t.after(() => dom.window.close());
  const window = dom.window;
  let state: Record<string, unknown> = { status: "connected", phones, providers: [], version: "0.8.190",
    runtimeUpdates: { enabled: true, lockedByEnvironment: false }, pendingUpdate: null, phoneLastSeenAt: NOW };
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const held: Array<(result: unknown) => void> = [];
  window.postMessage = ((data: { id?: number; method: string; params: { name: string; arguments: Record<string, unknown> } }) => {
    if (data.id === undefined) return;
    const reply = (result: unknown) => queueMicrotask(() => window.dispatchEvent(new window.MessageEvent("message", {
      source: window as unknown as Window, origin: "https://host.example",
      data: result === "host-error" ? { jsonrpc: "2.0", id: data.id, error: { code: -32001, message: "Request timed out" } }
        : { jsonrpc: "2.0", id: data.id, result } })));
    if (data.method === "ui/initialize") return reply({ protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} },
      hostContext: { theme: "dark", styles: { variables: { "--color-text-primary": "#fafafa", "bad name": "x" } } } });
    calls.push(data.params);
    if (data.params.name !== "remove_phones") return reply({ structuredContent: state });
    const result = answer(data.params.arguments);
    if (result === undefined) held.push(reply); else reply(result);
  }) as typeof window.postMessage;
  for (const name of CARD_SCRIPTS) {
    new Script(asset(name), { filename: fileURLToPath(new URL(`../card/${name}`, import.meta.url)) }).runInContext(dom.getInternalVMContext());
  }
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  await settle();
  const $ = (selector: string) => window.document.querySelector(selector) as HTMLElement | null;
  const rows = () => [...window.document.querySelectorAll("#phones li")] as HTMLElement[];
  return { window, $, rows, calls, held, settle, set: (next: Record<string, unknown>) => { state = { ...state, ...next }; },
    click: (selector: string) => { ($(selector) as HTMLButtonElement).click(); } };
}

test("one row per phone, a Remove on each, the 30-day action at the top, and Show all for a long list", async t => {
  const ui = await card(t, [live, ...Array.from({ length: 16 }, (_, i) => old(i + 2))]);
  assert.equal(ui.window.document.documentElement.dataset.theme, "dark", "the host's theme is applied");
  assert.equal(ui.window.document.documentElement.style.getPropertyValue("--color-text-primary"), "#fafafa");
  assert.equal(ui.window.document.documentElement.style.getPropertyValue("bad name"), "");
  assert.equal(ui.rows().length, 5);
  assert.match(ui.rows()[0]!.textContent!, /iPhone.*Active now.*Last seen just now/);
  assert.equal(ui.$("#phones-count")!.textContent, "17");
  assert.equal(ui.$("#stale-text")!.textContent, "16 phones not seen for 30 days");
  assert.equal(ui.$("#remove-stale")!.getAttribute("aria-label"), "Remove 16 phones not seen for 30 days");
  assert.equal(ui.$("#phones-toggle")!.textContent, "Show all 17 phones");
  ui.click("#phones-toggle");
  assert.equal(ui.rows().length, 17);
  assert.equal(ui.$("#phones-toggle")!.getAttribute("aria-expanded"), "true");
  assert.equal(ui.window.document.querySelectorAll("#phones button.remove").length, 17);
  assert.equal(ui.$("#phones button.remove")!.getAttribute("aria-label"), "Remove iPhone");
});

test("the only phone has no Remove and no 30-day action", async t => {
  const ui = await card(t, [live]);
  assert.equal(ui.window.document.querySelectorAll("#phones button.remove").length, 0);
  assert.equal(ui.$("#stale")!.classList.contains("hidden"), true);
  assert.equal(ui.$("#phones-note")!.classList.contains("hidden"), true);
  assert.equal(ui.$("#phones-toggle")!.classList.contains("hidden"), true);
});

test("Remove confirms in its row, waits for the phone with the card held, and reads the list again", async t => {
  const ui = await card(t, [live, old(2), old(3)]);
  const before = ui.calls.length;
  (ui.rows()[1]!.querySelector("button.remove") as HTMLButtonElement).click();
  assert.equal(ui.calls.length, before, "opening the confirmation calls nothing");
  assert.equal(ui.window.document.activeElement?.textContent, "Cancel");
  assert.match(ui.rows()[1]!.textContent!, /Remove Phone 000002 from this computer\?/);
  ui.window.document.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(ui.rows()[1]!.querySelector(".confirm"), null, "Escape cancels");
  assert.equal((ui.window.document.activeElement as HTMLElement).getAttribute("aria-label"), "Remove Phone 000002");
  (ui.rows()[1]!.querySelector("button.remove") as HTMLButtonElement).click();
  ui.click("[data-focus=confirm-removal]");
  await ui.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.at(-1))), { name: "remove_phones", arguments: { phoneIds: [old(2).id] } });
  assert.match(ui.rows()[1]!.textContent!, /Confirm on your phone/);
  assert.equal(ui.window.document.activeElement?.className, "waiting");
  assert.equal((ui.$("#refresh") as HTMLButtonElement).disabled, true, "nothing else starts while the phone is asked");
  assert.equal((ui.$("#phones-toggle") as HTMLButtonElement).disabled, false);
  ui.set({ phones: [live, old(3)] });
  ui.held.shift()!({ structuredContent: { status: "removed", removed: [old(2)], kept: [], remaining: 2 } });
  await ui.settle();
  assert.equal(ui.calls.at(-1)?.name, "connection_status");
  assert.equal(ui.rows().length, 2);
  assert.equal(ui.$("#phones-message")!.textContent, "Removed Phone 000002. 2 phones stay paired.");
  assert.equal(ui.$("#announce")!.textContent, "Removed Phone 000002. 2 phones stay paired.");
  assert.equal(ui.window.document.activeElement?.id, "phones-title", "the row is gone, so focus goes to the list");
  assert.equal((ui.$("#refresh") as HTMLButtonElement).disabled, false);
});

test("a refusal, a no and a lost answer are shown at the row that asked", async t => {
  const answers = [
    { isError: true, content: [{ type: "text", text: "That is every phone paired with this computer (2). Read connection_status again." }] },
    { structuredContent: { status: "declined", removed: [], kept: [], remaining: 2 } },
    "host-error",
  ];
  const ui = await card(t, [live, old(2)], () => answers.shift() ?? undefined);
  const remove = () => {
    (ui.rows()[1]!.querySelector("button.remove") as HTMLButtonElement).click();
    ui.click("[data-focus=confirm-removal]");
  };
  remove();
  await ui.settle();
  assert.match(ui.rows()[1]!.querySelector(".note.error")!.textContent!, /^That is every phone .* The list is up to date now; try again\.$/);
  remove();
  await ui.settle();
  assert.equal(ui.rows()[1]!.querySelector(".note")!.textContent, "You said no on your phone, so nothing was removed.");
  // The host gave up on the long call: the card says what that may mean and reads the list again.
  const before = ui.calls.length;
  remove();
  await ui.settle();
  assert.equal(ui.rows()[1]!.querySelector(".note")!.textContent,
    "This card stopped waiting. If you said yes on your phone, the removal went through. The list is up to date now.");
  assert.deepEqual(ui.calls.slice(before).map(call => call.name), ["remove_phones", "connection_status"]);
});

test("the 30-day action asks once for all stale phones", async t => {
  const ui = await card(t, [live, old(2), old(3)], () => ({ structuredContent: { status: "removed",
    removed: [old(2), old(3)], kept: [], remaining: 1 } }));
  ui.click("#remove-stale");
  assert.match(ui.$("#stale")!.textContent!, /Remove 2 phones not seen for 30 days\?/);
  ui.set({ phones: [live] });
  ui.click("[data-focus=confirm-removal]");
  await ui.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.name === "remove_phones"))),
    { name: "remove_phones", arguments: { notSeenForDays: 30 } });
  assert.equal(ui.$("#phones-message")!.textContent, "Removed 2 phones. 1 phone stays paired.");
  assert.equal(ui.$("#stale")!.classList.contains("hidden"), true);
});

test("this computer shows its version, a waiting update in plain words, and unpairing only by Terminal", async t => {
  const ui = await card(t, [live]);
  assert.equal(ui.$("#version")!.textContent, "0.8.190");
  assert.equal(ui.$("#update-none")!.classList.contains("hidden"), false);
  ui.set({ pendingUpdate: { version: "0.8.191", state: "downloaded", detail: "Downloaded. It takes over once the monitor's work…" } });
  ui.click("#refresh");
  await ui.settle();
  assert.equal(ui.$("#update-badge")!.textContent, "0.8.191 waiting");
  assert.equal(ui.$("#update-detail")!.textContent, "Downloaded. Installs when running work ends.");
  assert.match(ui.$("#update-detail")!.title, /monitor's work/);
  ui.set({ pendingUpdate: { version: "0.8.191", state: "selected", detail: "Selected." } });
  ui.click("#refresh");
  await ui.settle();
  assert.match(ui.$("#update-detail")!.textContent!, /next start/);
  const before = ui.calls.length;
  ui.click("#unpair");
  assert.equal(ui.$("#unpair-help")!.classList.contains("hidden"), false);
  assert.equal(ui.$("#reset-command")!.textContent, "granttap reset");
  assert.equal(ui.calls.length, before, "the card cannot unpair; it shows the command");
});

test("the served card inlines its style and every script in order", () => {
  const html = connectionCardHtml();
  assert.equal(html.includes("{{STYLE}}") || html.includes("{{SCRIPT}}"), false);
  assert.match(html, /--gt-danger-fill/);
  const at = CARD_SCRIPTS.map(name => html.indexOf(asset(name).slice(0, 80)));
  assert.ok(at.every(index => index > 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "view.js, which starts the card, comes last");
});
