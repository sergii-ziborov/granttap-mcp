import assert from "node:assert/strict";
import test from "node:test";
import { parseCLIModels } from "../cli-models";

test("Cursor and Grok native listings advertise only exact selectable IDs", () => {
  const cursor = parseCLIModels("Available models\n\nauto - Auto (default)\nfuture-model-high - Future High\nnot a model", "cursor", "mac", 100);
  assert.deepEqual(cursor.map(row => row.modelId), ["auto", "future-model-high"]);
  assert.equal(cursor[1]!.provider, "cursor");
  assert.equal(cursor[1]!.label, "Future High");
  assert.deepEqual(parseCLIModels("Available models:\n  * grok-future (default)\n  - grok-fast\n", "grok", "mac", 100)
    .map(row => row.modelId), ["grok-future", "grok-fast"]);
  assert.deepEqual(parseCLIModels("You are not authenticated.\n  * grok-cached (default)", "grok", "mac", 100), []);
});
