import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("OpenAI listing has supported copy, support and desktop execution metadata", () => {
  const path = join(import.meta.dirname, "../../../plugins/granttap/.codex-plugin/plugin.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const face = manifest.interface;
  assert.ok(face.shortDescription.length <= 30, "public subtitle is at most 30 characters");
  assert.ok(face.defaultPrompt.length <= 3, "public listing has at most three starters");
  for (const field of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    assert.equal(new URL(face[field]).protocol, "https:");
  }
  assert.equal(manifest.requires_local_executor, true);
});
