import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderAccountUsage } from "../../../../../../packages/protocol/schema";
import { savedNativeUsage } from "../saved";

test("the last readings are kept in a private file of numbers, and a damaged file remembers nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "granttap-native-usage-")), file = join(root, "native-usage.json");
  try {
    const store = savedNativeUsage(() => file);
    assert.deepEqual(store.read(), [], "nothing saved yet");
    const reading: ProviderAccountUsage = { provider: "claude", limitId: "claude", observedAt: 1_800_000_000_000,
      windows: [{ id: "primary", usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_900_000 }] };
    store.write([reading]);
    assert.deepEqual(savedNativeUsage(() => file).read(), [reading], "another process, or the next start, reads it back");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))[0]).sort(), ["limitId", "observedAt", "provider", "windows"]);
    writeFileSync(file, "{ not json");
    assert.deepEqual(store.read(), []);
    writeFileSync(file, JSON.stringify([{ provider: "claude", accessToken: "never-kept" }]));
    assert.deepEqual(store.read(), [], "anything that is not a reading is refused whole");
    store.write([{ ...reading, windows: [{ ...reading.windows[0]!, usedPercent: 500 }] }]);
    assert.deepEqual(store.read(), [], "an invalid reading is not written over the file's meaning");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
