import assert from "node:assert/strict";
import test from "node:test";
import { computerDisplayName } from "../../packages/core/computer-name";

test("Mac display name uses the user-visible Computer Name, not its network hostname", () => {
  assert.equal(computerDisplayName({
    platform: "darwin", host: "Mac.lan", macName: () => "Serhii’s MacBook Pro\n",
  }), "Serhii’s MacBook Pro");
});

test("display name falls back safely and permits a deliberate device label", () => {
  assert.equal(computerDisplayName({ platform: "darwin", host: "Mac.lan",
    macName: () => { throw new Error("missing"); } }), "Mac.lan");
  assert.equal(computerDisplayName({ platform: "linux", host: "workstation",
    override: "  Desk A  " }), "Desk A");
  assert.equal(computerDisplayName({ platform: "linux", host: "workstation",
    override: "bad\nname" }), "workstation");
});
