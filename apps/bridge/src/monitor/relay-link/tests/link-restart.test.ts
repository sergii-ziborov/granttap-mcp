import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimLinkRestart } from "..";

test("a monitor that cannot stay on the relay restarts at most once an hour, even across its own restarts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-link-restart-"));
  const previous = process.env.GRANTTAP_CONFIG_DIR;
  process.env.GRANTTAP_CONFIG_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.GRANTTAP_CONFIG_DIR; else process.env.GRANTTAP_CONFIG_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const start = Date.parse("2026-11-05T16:00:00Z");
  assert.equal(claimLinkRestart(start), true);
  assert.equal(claimLinkRestart(start + 30 * 60_000), false, "a second restart within the hour would only loop");
  assert.equal(claimLinkRestart(start + 61 * 60_000), true);
  assert.equal(claimLinkRestart(start - 24 * 60 * 60_000), true, "a clock set back does not block restarts forever");
});
