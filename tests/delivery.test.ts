import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  abandonDelivery,
  beginDelivery,
  completeDelivery,
  hasAcceptedDelivery,
} from "../apps/bridge/src/delivery";

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
  assert.equal(beginDelivery("message-a", now), "started");
  assert.equal(beginDelivery("message-a", now + 1), "processing");
  assert.equal(hasAcceptedDelivery("message-a", now + 1), false);
  completeDelivery("message-a", now + 2);
  assert.equal(hasAcceptedDelivery("message-a", now + 3), true);
  assert.equal(beginDelivery("message-a", now + 3), "completed");
  assert.equal(hasAcceptedDelivery("message-a", now + 8 * 24 * 60 * 60_000), false);

  assert.equal(beginDelivery("message-b", now), "started");
  abandonDelivery("message-b", now + 1);
  assert.equal(beginDelivery("message-b", now + 2), "started");

  assert.equal(beginDelivery("message-c", now), "started");
  assert.equal(beginDelivery("message-c", now + 6 * 60_000), "started");
});
