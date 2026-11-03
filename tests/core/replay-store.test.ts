import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadReplayFingerprints, RelayMessageAcceptance } from "../../packages/core/replay-store";

test("a message accepted while the disk refuses the replay file keeps the monitor alive", () => {
  const directory = mkdtempSync(join(tmpdir(), "granttap-replay-"));
  const path = join(directory, "replay.json");
  const acceptance = new RelayMessageAcceptance(path);
  chmodSync(directory, 0o500);
  try {
    assert.doesNotThrow(() => acceptance.accept("first"));
    assert.equal(acceptance.hasAccepted("first"), true, "the running process still refuses a replay");
  } finally {
    chmodSync(directory, 0o700);
  }
  acceptance.accept("second");
  assert.deepEqual(loadReplayFingerprints(path), ["first", "second"]);
});
