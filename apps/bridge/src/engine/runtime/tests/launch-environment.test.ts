import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { engineLaunchEnvironment } from "../engine-launch-environment";

const minimum = 32 * 1024 * 1024;
test("only the Engine child receives its parser stack reserve", () => {
  const parent = { GRANTTAP_ENGINE_ENABLED: "0", CUSTOM_VALUE: "preserved" };
  const child = engineLaunchEnvironment(parent, "/tmp/isolated-engine.sock", "darwin");
  assert.equal(child.RUST_MIN_STACK, String(minimum));
  assert.equal(child.GRANTTAP_ENGINE_SOCKET, "/tmp/isolated-engine.sock");
  assert.equal(child.GRANTTAP_ENGINE_ENABLED, "0", "Explicit disablement remains in force");
  assert.equal(child.CUSTOM_VALUE, "preserved");
  assert.equal(child.GRANTTAP_ENGINE_STATE_DIR, undefined);
  assert.deepEqual(parent, { GRANTTAP_ENGINE_ENABLED: "0", CUSTOM_VALUE: "preserved" });
});
test("larger explicit stacks survive and malformed or smaller values cannot reduce parser reserve", () => {
  for (const value of ["", "0", "-1", "1.5", "bad", "Infinity", "9007199254740992", "2097152"]) {
    assert.equal(engineLaunchEnvironment({ RUST_MIN_STACK: value }, "/tmp/e.sock", "linux").RUST_MIN_STACK,
      String(minimum), value);
  }
  assert.equal(engineLaunchEnvironment({ RUST_MIN_STACK: "67108864" }, "/tmp/e.sock", "linux").RUST_MIN_STACK,
    "67108864");
});
test("the Windows Engine keeps its private state directory alongside the parser reserve", () => {
  const child = engineLaunchEnvironment({}, "/tmp/e.sock", "win32");
  assert.equal(child.RUST_MIN_STACK, String(minimum));
  assert.ok(child.GRANTTAP_ENGINE_STATE_DIR?.endsWith(join("engine", "state")));
});
