import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasAcceptedDelivery, rememberAcceptedDelivery } from "../apps/bridge/src/delivery";

test("delivery ledger makes phone retries idempotent and expires old ids", async (t) => {
  const configDir = await mkdtemp(join(tmpdir(), "granttap-delivery-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = configDir;
  t.after(() => {
    if (previous == null) delete process.env.GRANTTAP_CONFIG_DIR;
    else process.env.GRANTTAP_CONFIG_DIR = previous;
  });

  const now = Date.now();
  assert.equal(hasAcceptedDelivery("message-a", now), false);
  rememberAcceptedDelivery("message-a", now);
  assert.equal(hasAcceptedDelivery("message-a", now + 1), true);
  assert.equal(hasAcceptedDelivery("message-a", now + 8 * 24 * 60 * 60_000), false);
});
