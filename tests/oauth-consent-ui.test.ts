import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { consentHtml } from "../apps/mcp/src/oauth/consent-page";

test("paired Codex consent does not rotate keys until the second reconnect click", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const html = consentHtml({
    pendingId: "pending-test-id", paired: true, clientName: "Codex",
    redirectUri: "http://127.0.0.1:49123/callback/granttap",
    scopes: ["mcp:tools"], resource: "http://127.0.0.1:17342/mcp",
  });
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:17342/authorize",
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window, "fetch", { value: async (url: string, init: { body: URLSearchParams }) => {
        requests.push({ url, body: init.body.toString() });
        return {
          ok: true,
          json: async () => ({ alreadyPaired: false, qrDataUrl: "data:image/png;base64,ZmFrZQ==", manualToken: "test-token" }),
        };
      } });
    },
  });
  const document = dom.window.document;
  assert.deepEqual(requests, []);
  assert.equal(document.querySelector<HTMLButtonElement>("#approve")?.disabled, false);
  const confirmation = document.querySelector<HTMLElement>("#reconnect-confirm");
  assert.equal(confirmation?.hidden, true);
  document.querySelector<HTMLElement>("#reconnect")?.click();
  assert.equal(confirmation?.hidden, false);
  assert.deepEqual(requests, []);
  document.querySelector<HTMLElement>("#cancel-reconnect")?.click();
  assert.equal(confirmation?.hidden, true);
  assert.deepEqual(requests, []);
  document.querySelector<HTMLElement>("#reconnect")?.click();
  document.querySelector<HTMLElement>("#confirm-reconnect")?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, [{ url: "/oauth/pairing", body: "pending_id=pending-test-id&confirmed=true" }]);
  assert.match(document.querySelector<HTMLImageElement>("#qr img")?.src ?? "", /^data:image\/png;base64,/);
  assert.equal(document.querySelector<HTMLElement>("#manual-code")?.textContent, "test-token");
  dom.window.close();
});
