import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { observedCheckoutRoot, withCheckoutObservationCache } from "..";

test("overlapping catalog passes keep checkout caches private across asynchronous work", async t => {
  const root = mkdtempSync(join(tmpdir(), "granttap-checkout-scope-"));
  const original = join(root, "original"), observed = join(root, "observed");
  const bin = join(root, "bin"), calls = join(root, "calls");
  for (const path of [original, observed, bin]) mkdirSync(path);
  for (const path of [original, observed]) execFileSync("/usr/bin/git", ["init", "-q", path]);
  const prior = process.env.PATH;
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf x >> '${calls}'\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${prior}`;
  t.after(() => { process.env.PATH = prior; rmSync(root, { recursive: true, force: true }); });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const observe = () => assert.equal(observedCheckoutRoot(original,
    [observed, observed, observed]), realpathSync(observed));
  const first = withCheckoutObservationCache(async () => {
    observe();
    await hold;
    await setImmediate();
    withCheckoutObservationCache(observe);
  });
  await withCheckoutObservationCache(async () => {
    observe();
    await setImmediate();
    observe();
  });
  release();
  await first;
  assert.equal(readFileSync(calls, "utf8").length, 4,
    "Concurrent scans independently verify two roots, then reuse only their own observations");
});
